import { ArcData } from "@arctools/arc-data";
import { bindData } from "@arctools/arc-data/cloudflare";
import { executeCommand } from "@arctools/commands";
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Layer,
  Context,
  Cause,
  Clock,
  Deferred,
  Effect,
  Match,
  Predicate,
  Result,
  Schema,
} from "effect";

import { AttemptId, Deadline } from "./contracts.js";
import {
  DiscordResponse,
  discordResponse,
  encodedBytes,
  friendlyFailure,
  twitchParts,
} from "./presentation.js";
import {
  Admission,
  DiscordReceipt,
  TenantError,
  Tenants,
  TwitchReceipt,
} from "./tenant-contracts.js";
import {
  TenantBoundaryObserver,
  TenantDiagnostic,
  TenantTrace,
} from "./tenant-diagnostics.js";
import {
  type Claim,
  emptyTenant,
  fits,
  nextAlarm,
  reclaim,
  sameClaim,
  TenantState,
  TenantStore,
  tenantPolicy,
  type Work,
} from "./tenant-state.js";
import { AccountError, Dispatch, TwitchAccount } from "./twitch-contracts.js";
import { bindAccount } from "./twitch.js";

type TwitchComputing = Extract<
  Work,
  { transport: "twitch"; kind: "computing" }
>;

type Delivering = Extract<Work, { kind: "delivering" }>;

const failure = () => discordResponse(friendlyFailure, true);

const base = (work: Work) => ({
  id: work.id,
  fingerprint: work.fingerprint,
  transport: work.transport,
  receivedAt: work.receivedAt,
  deadline: work.deadline,
  retainUntil: work.retainUntil,
});

const stopTwitch = (
  work: Extract<Work, { transport: "twitch" }>,
  outcome: "sent" | "rejected" | "ambiguous" | "expired",
): Work => ({ ...base(work), transport: "twitch", kind: "terminal", outcome });

const stopDiscord = (
  work: Extract<Work, { transport: "discord" }>,
  response: DiscordResponse,
): Work => ({
  ...base(work),
  transport: "discord",
  kind: "terminal",
  response,
});

export const makeTenant = Effect.fnUntraced(function* (options: {
  readonly activation: string;
  readonly launch: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}) {
  const store = yield* TenantStore;
  const data = yield* ArcData;
  const account = yield* TwitchAccount;

  const inFlight = new Map<
    string,
    { readonly claim: Claim; readonly done: Deferred.Deferred<void> }
  >();

  const claim = (
    state: TenantState,
    now: number,
    deadline: number,
    duration: number,
  ): Claim => ({
    generation: ++state.generation,
    activation: options.activation,
    until: Math.min(deadline, now + duration),
  });

  const matches = (
    current: Work | undefined,
    captured: { readonly claim: Claim },
  ) =>
    Predicate.isNotUndefined(current) &&
    Predicate.hasProperty(current, "claim") &&
    sameClaim(current.claim, captured.claim);

  const decision = Effect.fnUntraced(function* (
    phase: TenantTrace["phase"],
    code: TenantTrace["code"],
  ) {
    (yield* TenantDiagnostic).decision(phase, code);
    yield* Effect.logInfo("Tenant response decision").pipe(
      Effect.annotateLogs({ phase, code, activation: options.activation }),
    );
  });

  const computeText = (work: Extract<Work, { kind: "computing" }>) =>
    executeCommand({
      ...work.invocation,
      deadline: work.transport === "discord" ? work.claim.until : work.deadline,
    }).pipe(
      Effect.provideService(ArcData, data),
      Effect.map((reply) => ({
        text: reply.text,
        failed: false,
        code: "success" as const,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          text: error.message,
          failed: true,
          code: "command-error" as const,
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) || !Cause.hasDies(cause)
          ? Effect.failCause(cause)
          : Effect.logError("Command execution failed").pipe(
              Effect.annotateLogs({ phase: "command", code: "command-defect" }),
              Effect.as({
                text: friendlyFailure,
                failed: true,
                code: "command-defect" as const,
              }),
            ),
      ),
    );

  const dispatchWork = Effect.fnUntraced(function* (work: Delivering) {
    const payload = work.plan[work.cursor];

    if (!payload) return yield* Effect.die("Invalid delivery cursor");
    const now = yield* Clock.currentTimeMillis;

    if (now >= work.deadline) {
      yield* store.update((state) => {
        if (matches(state.works[work.id], work))
          state.works[work.id] = stopTwitch(work, "expired");
      });

      return;
    }

    const outcome = yield* account.dispatch(payload).pipe(
      Effect.timeout(work.deadline - now),
      Effect.mapError(() => new AccountError({ code: "provider" })),
      Effect.result,
    );

    const completedAt = yield* Clock.currentTimeMillis;

    const again = yield* store.update((state) => {
      if (!matches(state.works[work.id], work)) return false;

      if (Result.isFailure(outcome)) {
        if (completedAt >= work.deadline)
          state.works[work.id] = stopTwitch(work, "expired");
        else
          state.works[work.id] = {
            ...work,
            claim: {
              ...work.claim,
              until: Math.min(work.deadline, completedAt + 250),
            },
          };

        return false;
      }

      const result = outcome.success;

      return Match.value(result).pipe(
        Match.discriminators("kind")({
          sent: () => {
            if (
              work.cursor + 1 < work.plan.length &&
              completedAt < work.deadline
            ) {
              state.works[work.id] = {
                ...base(work),
                transport: "twitch",
                kind: "ready",
                plan: work.plan,
                cursor: work.cursor + 1,
                retryAt: completedAt,
              };

              return true;
            }

            state.works[work.id] = stopTwitch(
              work,
              work.cursor + 1 === work.plan.length ? "sent" : "expired",
            );

            return false;
          },
          retryable: (result) => {
            if (completedAt < work.deadline && result.retryAt < work.deadline) {
              state.works[work.id] = {
                ...base(work),
                transport: "twitch",
                kind: "ready",
                plan: work.plan,
                cursor: work.cursor,
                retryAt: Math.max(completedAt, result.retryAt),
              };
            } else state.works[work.id] = stopTwitch(work, "expired");

            return false;
          },
        }),
        Match.whenOr(
          { kind: "rejected" },
          { kind: "ambiguous" },
          { kind: "expired" },
          (result) => {
            state.works[work.id] = stopTwitch(work, result.kind);

            return false;
          },
        ),
        Match.exhaustive,
      );
    });

    if (again) yield* run(work.id);
  });

  const deliver = Effect.fnUntraced(function* (work: Delivering) {
    const done = yield* Deferred.make<void>();
    const pending = { claim: work.claim, done };
    inFlight.set(work.id, pending);
    yield* dispatchWork(work).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (inFlight.get(work.id) === pending) inFlight.delete(work.id);
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      ),
    );
  });

  const computeTwitch = Effect.fnUntraced(function* (work: TwitchComputing) {
    const reply = yield* computeText(work);
    const now = yield* Clock.currentTimeMillis;

    const proceed = yield* store.update((state) => {
      if (!matches(state.works[work.id], work)) return false;

      if (now >= work.deadline) {
        state.works[work.id] = stopTwitch(work, "expired");

        return false;
      }

      if (now >= work.claim.until) return false;

      let plan = twitchParts(reply.text).map((text, index) => ({
        attemptId: AttemptId.make(`${work.id}:${index}`),
        broadcasterId: work.broadcasterId,
        replyParentId: work.replyParentId,
        text,
        deadline: work.deadline,
      }));

      if (encodedBytes(plan) > tenantPolicy.reservation - 512)
        plan = [
          {
            attemptId: AttemptId.make(`${work.id}:0`),
            broadcasterId: work.broadcasterId,
            replyParentId: work.replyParentId,
            text:
              twitchParts(
                "That result is too long to send. Please try a more specific search.",
              )[0] ?? friendlyFailure,
            deadline: work.deadline,
          },
        ];

      const validPlan = Schema.decodeUnknownSync(
        Schema.NonEmptyArray(Dispatch),
      )(plan);

      state.works[work.id] = {
        ...base(work),
        transport: "twitch",
        kind: "ready",
        plan: validPlan,
        cursor: 0,
        retryAt: now,
      };

      return true;
    });

    if (proceed) yield* run(work.id);
  });

  const run = Effect.fnUntraced(function* (id: string): Effect.fn.Return<void> {
    const now = yield* Clock.currentTimeMillis;

    const action = yield* store.update(
      (
        state,
      ):
        | TwitchComputing
        | Delivering
        | {
            readonly kind: "joining";
            readonly done: Deferred.Deferred<void>;
            readonly deadline: number;
          }
        | null => {
        const work = state.works[id];

        if (!work || work.transport !== "twitch" || work.kind === "terminal")
          return null;

        if (now >= work.deadline) {
          state.works[id] = stopTwitch(work, "expired");

          return null;
        }

        return Match.value(work).pipe(
          Match.discriminators("kind")({
            ready: (work) => {
              if (now < work.retryAt) return null;

              const next: Delivering = {
                ...base(work),
                transport: "twitch",
                kind: "delivering",
                plan: work.plan,
                cursor: work.cursor,
                claim: claim(
                  state,
                  now,
                  work.deadline,
                  tenantPolicy.deliveryLeaseMs,
                ),
              };

              state.works[id] = next;

              return next;
            },
            delivering: (work) => {
              if (
                work.claim.activation === options.activation &&
                now < work.claim.until
              )
                return null;
              const pending = inFlight.get(id);

              if (pending && sameClaim(work.claim, pending.claim))
                return {
                  kind: "joining",
                  done: pending.done,
                  deadline: work.deadline,
                } satisfies {
                  readonly kind: "joining";
                  readonly done: Deferred.Deferred<void>;
                  readonly deadline: number;
                };

              const next: Delivering = {
                ...work,
                claim: claim(
                  state,
                  now,
                  work.deadline,
                  tenantPolicy.deliveryLeaseMs,
                ),
              };

              state.works[id] = next;

              return next;
            },
          }),
          Match.whenOr({ kind: "computing" }, { kind: "accepted" }, (work) => {
            if (
              work.kind === "computing" &&
              work.claim.activation === options.activation &&
              now < work.claim.until
            )
              return null;

            const next: TwitchComputing = {
              ...work,
              kind: "computing",
              claim: claim(state, now, work.deadline, tenantPolicy.leaseMs),
            };

            state.works[id] = next;

            return next;
          }),
          Match.exhaustive,
        );
      },
    );

    yield* Match.value(action).pipe(
      Match.when(Predicate.isNullish, () => Effect.void),
      Match.discriminatorsExhaustive("kind")({
        computing: computeTwitch,
        delivering: deliver,
        joining: Effect.fnUntraced(function* (action) {
          yield* Deferred.await(action.done).pipe(
            Effect.timeout(Math.max(1, action.deadline - now)),
            Effect.catch(() => Effect.void),
          );
          yield* run(id);
        }),
      }),
    );
  });

  const admit = Effect.fnUntraced(function* (
    receipt: TwitchReceipt | DiscordReceipt,
    transport: "twitch" | "discord",
  ) {
    const now = yield* Clock.currentTimeMillis;

    const result = yield* store.update((state) => {
      reclaim(state, now);

      for (const [id, work] of Object.entries(state.works))
        if (
          work.transport === "discord" &&
          work.kind === "computing" &&
          (work.claim.activation !== options.activation ||
            now >= work.claim.until)
        )
          state.works[id] = stopDiscord(work, failure());

      const tenant = Predicate.hasProperty(receipt, "broadcasterId")
        ? `twitch:${receipt.broadcasterId}`
        : `discord:${receipt.guildId}`;

      if (Predicate.isNotNull(state.tenant) && state.tenant !== tenant)
        return { kind: "input" } as const;

      const previous = Object.hasOwn(state.works, receipt.id)
        ? state.works[receipt.id]
        : undefined;

      if (previous)
        return previous.fingerprint === receipt.fingerprint
          ? ({ kind: "duplicate", work: previous } as const)
          : ({ kind: "conflict" } as const);

      const deadline = Deadline.make(
        receipt.receivedAt + (transport === "twitch" ? 10_000 : 3000),
      );

      if (now >= deadline) return { kind: "input" } as const;

      const shared = {
        id: receipt.id,
        fingerprint: receipt.fingerprint,
        receivedAt: receipt.receivedAt,
        deadline,
        retainUntil: deadline + tenantPolicy.retentionMs,
      };

      const work: Work = Predicate.hasProperty(receipt, "broadcasterId")
        ? {
            ...shared,
            transport: "twitch",
            kind: "computing",
            invocation: receipt.invocation,
            broadcasterId: receipt.broadcasterId,
            replyParentId: receipt.replyParentId,
            claim: claim(state, now, deadline, tenantPolicy.leaseMs),
          }
        : {
            ...shared,
            transport: "discord",
            kind: "computing",
            invocation: receipt.invocation,
            claim: claim(
              state,
              now,
              receipt.receivedAt + tenantPolicy.computeMs,
              tenantPolicy.computeMs,
            ),
          };

      state.works[receipt.id] = work;

      if (!fits(state)) {
        delete state.works[receipt.id];

        return { kind: "capacity" } as const;
      }

      state.tenant = tenant;

      return { kind: "accepted", work } as const;
    });

    const trace: TenantTrace = {
      phase: "admission",
      code: result.kind,
      admissionDeltaMs: now - receipt.receivedAt,
      cutoff:
        result.kind === "accepted" || result.kind === "duplicate"
          ? result.work.deadline
          : receipt.receivedAt + (transport === "twitch" ? 10000 : 3000),
      activation: options.activation,
    };

    (yield* TenantDiagnostic).admission(trace);
    yield* Effect.logInfo("Tenant admission decision").pipe(
      Effect.annotateLogs(trace),
    );

    return result;
  });

  const acceptTwitch = Effect.fn("Tenant.acceptTwitch")(function* (
    input: TwitchReceipt,
  ) {
    const receipt = yield* Schema.decodeUnknownEffect(TwitchReceipt)(
      input,
    ).pipe(Effect.mapError(() => new TenantError({ code: "input" })));

    const result = yield* admit(receipt, "twitch");

    if (result.kind !== "accepted" && result.kind !== "duplicate")
      return yield* new TenantError({ code: result.kind });

    if (
      result.kind === "accepted" &&
      result.work.transport === "twitch" &&
      result.work.kind === "computing"
    )
      yield* options.launch(computeTwitch(result.work));

    return { kind: result.kind } satisfies Admission;
  });

  const respondDiscord = Effect.fn("Tenant.respondDiscord")(function* (
    input: DiscordReceipt,
  ) {
    const receipt = yield* Schema.decodeUnknownEffect(DiscordReceipt)(
      input,
    ).pipe(Effect.mapError(() => new TenantError({ code: "input" })));

    const result = yield* admit(receipt, "discord");

    if (result.kind !== "accepted" && result.kind !== "duplicate")
      return yield* new TenantError({ code: result.kind });
    const work = result.work;

    if (work.transport !== "discord")
      return yield* new TenantError({ code: "conflict" });

    if (work.kind === "terminal") {
      yield* decision("committed", "recorded");

      return work.response;
    }

    if (result.kind === "accepted") {
      const reply = yield* computeText(work);
      const now = yield* Clock.currentTimeMillis;

      const committed = yield* store.update((state) => {
        const latest = state.works[work.id];

        if (latest?.transport === "discord" && latest.kind === "terminal")
          return { response: latest.response, code: "recorded" as const };

        if (!matches(latest, work)) return null;

        const response =
          now >= work.claim.until
            ? failure()
            : discordResponse(reply.text, reply.failed);

        state.works[work.id] = stopDiscord(work, response);

        return {
          response,
          code: now >= work.claim.until ? ("timeout" as const) : reply.code,
        };
      });

      if (committed) {
        yield* decision("committed", committed.code);

        return committed.response;
      }
    }

    for (let reads = 0; reads < 100; reads++) {
      const now = yield* Clock.currentTimeMillis;
      const current = (yield* store.read).works[work.id];

      if (!current || current.transport !== "discord") {
        yield* decision("uncommitted", "missing");

        return failure();
      }

      if (current.kind === "terminal") {
        yield* decision("committed", "recorded");

        return current.response;
      }

      let response: DiscordResponse | null = null;

      if (
        current.claim.activation !== options.activation ||
        now >= current.claim.until
      ) {
        response = yield* store.update((state) => {
          const latest = state.works[work.id];

          if (!latest || latest.transport !== "discord") return failure();

          if (latest.kind === "terminal") return latest.response;

          if (
            latest.claim.activation === options.activation &&
            now < latest.claim.until
          )
            return null;
          const response = failure();
          state.works[work.id] = stopDiscord(latest, response);

          return response;
        });
      }

      if (response) {
        yield* decision(
          "committed",
          current.claim.activation !== options.activation
            ? "interrupted"
            : "timeout",
        );

        return response;
      }

      yield* Effect.sleep(25);
    }

    yield* decision("uncommitted", "wait-limit");

    return failure();
  });

  const recover = Effect.fn("Tenant.recover")(function* () {
    const now = yield* Clock.currentTimeMillis;

    const ids = yield* store.update((state) => {
      reclaim(state, now);

      return Object.values(state.works)
        .filter(
          (work) =>
            work.transport === "twitch" &&
            work.kind !== "terminal" &&
            (now >= work.deadline ||
              work.kind === "accepted" ||
              (work.kind === "ready"
                ? now >= work.retryAt
                : work.claim.activation !== options.activation ||
                  now >= work.claim.until)),
        )
        .slice(0, 4)
        .map((work) => work.id);
    });

    yield* Effect.forEach(ids, run, { concurrency: 4, discard: true });
  });

  return { acceptTwitch, respondDiscord, recover };
});

export const makeTenantStorage = Effect.fnUntraced(function* () {
  const { storage } = yield* Cloudflare.DurableObjectState;
  const runtime = yield* RuntimeContext;

  const read = Effect.gen(function* () {
    const raw = yield* storage.get("tenant:v1");

    return Predicate.isUndefined(raw)
      ? emptyTenant()
      : yield* Schema.decodeUnknownEffect(TenantState)(raw).pipe(Effect.orDie);
  });

  return TenantStore.of({
    read: read.pipe(Effect.provideService(RuntimeContext, runtime)),
    update: (f) =>
      storage
        .transaction(
          Effect.gen(function* () {
            const raw = yield* storage.get("tenant:v1");

            const state: TenantState = Predicate.isUndefined(raw)
              ? emptyTenant()
              : yield* Schema.decodeUnknownEffect(TenantState)(raw).pipe(
                  Effect.orDie,
                );

            const result = f(state);

            const encoded = yield* Schema.encodeEffect(TenantState)(state).pipe(
              Effect.orDie,
            );

            if (encodedBytes(encoded) > tenantPolicy.bytes)
              return yield* Effect.die("Tenant capacity exceeded");
            yield* storage.put("tenant:v1", encoded);
            const alarm = nextAlarm(state);

            if ((yield* storage.getAlarm()) !== alarm)
              yield* Predicate.isNull(alarm)
                ? storage.deleteAlarm()
                : storage.setAlarm(alarm);

            return result;
          }),
        )
        .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie),
  });
});

export class TenantDO extends Cloudflare.DurableObject<TenantDO>()(
  "Tenant",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const dataClient = yield* bindData;
    const accountClient = yield* bindAccount;

    return Effect.gen(function* () {
      const data = yield* dataClient;
      const account = yield* accountClient;
      const runtime = yield* RuntimeContext;

      const store = yield* makeTenantStorage().pipe(
        Effect.provideService(Cloudflare.DurableObjectState, state),
      );

      const activation = crypto.randomUUID();

      const tenant = yield* makeTenant({
        activation,
        launch: (effect) =>
          state
            .waitUntil(effect)
            .pipe(Effect.provideService(RuntimeContext, runtime)),
      }).pipe(
        Effect.provideService(TenantStore, store),
        Effect.provideService(ArcData, data),
        Effect.provideService(TwitchAccount, account),
      );

      const reply = Effect.fnUntraced(function* <A>(
        input: TwitchReceipt | DiscordReceipt,
        effect: Effect.Effect<A, TenantError>,
      ) {
        let trace: TenantTrace = {
          phase: "uncommitted",
          code: "rpc-entry",
          admissionDeltaMs: (yield* Clock.currentTimeMillis) - input.receivedAt,
          cutoff:
            input.receivedAt +
            (Predicate.hasProperty(input, "guildId") ? 3000 : 10000),
          activation,
        };

        const value = yield* effect.pipe(
          Effect.match({
            onSuccess: (value) => ({ kind: "success", value }) as const,
            onFailure: (error) =>
              ({ kind: "failure", code: error.code }) as const,
          }),
          Effect.provideService(TenantDiagnostic, {
            admission: (value) => {
              trace = value;
            },
            decision: (phase, code) => {
              trace = { ...trace, phase, code };
            },
          }),
        );

        return { ...value, trace };
      });

      return {
        acceptTwitch: (receipt: TwitchReceipt) =>
          reply(receipt, tenant.acceptTwitch(receipt)),
        respondDiscord: (receipt: DiscordReceipt) =>
          reply(receipt, tenant.respondDiscord(receipt)),
        alarm: () => tenant.recover(),
      };
    });
  }),
) {}

export const bindTenants = Effect.gen(function* () {
  const objects = yield* TenantDO;

  return Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const observer = yield* TenantBoundaryObserver;

    const decode = Effect.fnUntraced(function* <A, I, E>(
      invoke: () => Effect.Effect<unknown, E, RuntimeContext>,
      schema: Schema.Codec<A, I>,
    ) {
      observer.lookup();
      const effect = invoke();
      observer.rpc();

      const raw = yield* effect.pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.mapError(() => new TenantError({ code: "unavailable" })),
      );

      const response = yield* Schema.decodeUnknownEffect(
        Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("success"),
            value: schema,
            trace: TenantTrace,
          }),
          Schema.Struct({
            kind: Schema.Literal("failure"),
            code: TenantError.fields.code,
            trace: TenantTrace,
          }),
        ]),
      )(raw).pipe(
        Effect.mapError(() => new TenantError({ code: "unavailable" })),
      );

      observer.result(response.trace);

      if (response.kind === "failure")
        return yield* new TenantError({ code: response.code });

      return response.value;
    });

    return Tenants.of({
      acceptTwitch: (receipt) =>
        decode(
          () =>
            objects
              .getByName(`twitch:${receipt.broadcasterId}`)
              .acceptTwitch(receipt),
          Admission,
        ),
      respondDiscord: (receipt) =>
        decode(
          () =>
            objects
              .getByName(`discord:${receipt.guildId}`)
              .respondDiscord(receipt),
          DiscordResponse,
        ),
    });
  });
});

export class TenantService extends Context.Service<
  TenantService,
  Effect.Success<ReturnType<typeof makeTenant>>
>()("@arctools/TenantService") {}

export const tenantServiceLayer = (options: Parameters<typeof makeTenant>[0]) =>
  Layer.effect(TenantService, makeTenant(options));

export const tenantStorageLayer = Layer.effect(
  TenantStore,
  makeTenantStorage(),
);
