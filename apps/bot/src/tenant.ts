import { ArcData } from "@arctools/arc-data";
import { bindData } from "@arctools/arc-data/cloudflare";
import { executeCommand } from "@arctools/commands";
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Clock, Effect, Schema } from "effect";
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
import { bindAccount } from "./twitch.js";
import { Dispatch, TwitchAccount } from "./twitch-contracts.js";

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
    current !== undefined &&
    "claim" in current &&
    sameClaim(current.claim, captured.claim);
  const computeText = (work: Extract<Work, { kind: "computing" }>) =>
    executeCommand({
      ...work.invocation,
      deadline: work.transport === "discord" ? work.claim.until : work.deadline,
    }).pipe(
      Effect.provideService(ArcData, data),
      Effect.map((reply) => ({ text: reply.text, failed: false })),
      Effect.catch((error) =>
        Effect.succeed({ text: error.message, failed: true }),
      ),
    );
  const deliver = Effect.fnUntraced(function* (work: Delivering) {
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
    const outcome = yield* account.dispatch(payload).pipe(Effect.result);
    const completedAt = yield* Clock.currentTimeMillis;
    const again = yield* store.update((state) => {
      if (!matches(state.works[work.id], work)) return false;
      if (outcome._tag === "Failure") {
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
      if (
        result.kind === "sent" &&
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
      if (result.kind === "retryable") {
        if (result.retryAt > completedAt && result.retryAt < work.deadline) {
          state.works[work.id] = {
            ...base(work),
            transport: "twitch",
            kind: "ready",
            plan: work.plan,
            cursor: work.cursor,
            retryAt: result.retryAt,
          };
        } else state.works[work.id] = stopTwitch(work, "expired");
        return false;
      }
      state.works[work.id] = stopTwitch(
        work,
        result.kind === "sent"
          ? work.cursor + 1 === work.plan.length
            ? "sent"
            : "expired"
          : result.kind,
      );
      return false;
    });
    if (again) yield* run(work.id);
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
      (state): TwitchComputing | Delivering | null => {
        const work = state.works[id];
        if (!work || work.transport !== "twitch" || work.kind === "terminal")
          return null;
        if (now >= work.deadline) {
          state.works[id] = stopTwitch(work, "expired");
          return null;
        }
        if (work.kind === "ready") {
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
        }
        if (
          work.kind !== "accepted" &&
          work.claim.activation === options.activation &&
          now < work.claim.until
        )
          return null;
        if (work.kind === "delivering") {
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
        }
        const next: TwitchComputing = {
          ...work,
          kind: "computing",
          claim: claim(state, now, work.deadline, tenantPolicy.leaseMs),
        };
        state.works[id] = next;
        return next;
      },
    );
    if (action?.kind === "computing") yield* computeTwitch(action);
    if (action?.kind === "delivering") yield* deliver(action);
  });
  const admit = Effect.fnUntraced(function* (
    receipt: TwitchReceipt | DiscordReceipt,
    transport: "twitch" | "discord",
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* store.update((state) => {
      reclaim(state, now);
      const tenant =
        "broadcasterId" in receipt
          ? `twitch:${receipt.broadcasterId}`
          : `discord:${receipt.guildId}`;
      if (state.tenant !== null && state.tenant !== tenant)
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
      if (receipt.receivedAt > now || now >= deadline)
        return { kind: "input" } as const;
      const shared = {
        id: receipt.id,
        fingerprint: receipt.fingerprint,
        receivedAt: receipt.receivedAt,
        deadline,
        retainUntil: deadline + tenantPolicy.retentionMs,
      };
      const work: Work =
        "broadcasterId" in receipt
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
    if (work.kind === "terminal") return work.response;
    if (result.kind === "accepted") {
      const reply = yield* computeText(work);
      const now = yield* Clock.currentTimeMillis;
      yield* store.update((state) => {
        if (matches(state.works[work.id], work))
          state.works[work.id] = stopDiscord(
            work,
            now >= work.claim.until
              ? failure()
              : discordResponse(reply.text, reply.failed),
          );
      });
    }
    for (let reads = 0; reads < 100; reads++) {
      const now = yield* Clock.currentTimeMillis;
      const current = (yield* store.read).works[work.id];
      if (!current || current.transport !== "discord") return failure();
      if (current.kind === "terminal") return current.response;
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
      if (response) return response;
      yield* Effect.sleep(25);
    }
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
    return raw === undefined
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
            const state: TenantState =
              raw === undefined
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
              yield* alarm === null
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
      const tenant = yield* makeTenant({
        activation: crypto.randomUUID(),
        launch: (effect) =>
          state
            .waitUntil(effect)
            .pipe(Effect.provideService(RuntimeContext, runtime)),
      }).pipe(
        Effect.provideService(TenantStore, store),
        Effect.provideService(ArcData, data),
        Effect.provideService(TwitchAccount, account),
      );
      const reply = <A>(effect: Effect.Effect<A, TenantError>) =>
        effect.pipe(
          Effect.match({
            onSuccess: (value) => ({ kind: "success", value }) as const,
            onFailure: (error) =>
              ({ kind: "failure", code: error.code }) as const,
          }),
        );
      return {
        acceptTwitch: (receipt: TwitchReceipt) =>
          reply(tenant.acceptTwitch(receipt)),
        respondDiscord: (receipt: DiscordReceipt) =>
          reply(tenant.respondDiscord(receipt)),
        alarm: () => tenant.recover(),
      };
    });
  }),
) {}
export const bindTenants = Effect.gen(function* () {
  const objects = yield* TenantDO;
  return Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const decode = Effect.fnUntraced(function* <A, I, E>(
      effect: Effect.Effect<unknown, E, RuntimeContext>,
      schema: Schema.Codec<A, I>,
    ) {
      const raw = yield* effect.pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.mapError(() => new TenantError({ code: "unavailable" })),
      );
      const response = yield* Schema.decodeUnknownEffect(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("success"), value: schema }),
          Schema.Struct({
            kind: Schema.Literal("failure"),
            code: TenantError.fields.code,
          }),
        ]),
      )(raw).pipe(
        Effect.mapError(() => new TenantError({ code: "unavailable" })),
      );
      if (response.kind === "failure")
        return yield* new TenantError({ code: response.code });
      return response.value;
    });
    return Tenants.of({
      acceptTwitch: (receipt) =>
        decode(
          objects
            .getByName(`twitch:${receipt.broadcasterId}`)
            .acceptTwitch(receipt),
          Admission,
        ),
      respondDiscord: (receipt) =>
        decode(
          objects
            .getByName(`discord:${receipt.guildId}`)
            .respondDiscord(receipt),
          DiscordResponse,
        ),
    });
  });
});
