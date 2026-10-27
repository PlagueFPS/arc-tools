/* oxlint-disable effecttsgo/crypto-random-uuid -- Native fixture callbacks allocate secure operation IDs synchronously. */
/* oxlint-disable effecttsgo/global-fetch-in-effect -- The transport test exercises native Fetch cancellation and wire behavior at the HTTP boundary. */
/* oxlint-disable effecttsgo/run-effect-inside-effect -- Native fixture callbacks need synchronous values or Promises from the simulated Effect services. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { expect } from "bun:test";

import { makeAccountStorage } from "@arctools/twitch/cloudflare";
import { AccountError } from "@arctools/twitch/server";
import {
  makeAccount,
  makeProvider,
  TwitchProvider,
  SharedAccount,
  AccountStore,
  policy,
} from "@arctools/twitch/testing";
import { randomUUID as secureRandomUUID } from "@arctools/utils/http";
import { providerTransport } from "@arctools/utils/http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import {
  Predicate,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Semaphore,
  Array as Arr,
  Record as Rec,
  String as Str,
} from "effect";

import { EnvironmentConfig } from "../../apps/bot/src/config.js";
import {
  AccountAttribution,
  attributionLimit,
  CurrentValidationOrigin,
  credentialFingerprint,
  observeValidations,
  readAccountAttribution,
  recordActivation,
  recordCompletedAlarm,
  validationEndpoints,
} from "./alarm-attribution.js";
import {
  type CompletedRecoveryEvidence,
  completedRunKey,
  selectCompletedRun,
  verifyCompletedRecovery,
  verifyCompletedValidation,
} from "./completed-recovery.js";
import { makeProviderFixture } from "./twitch-provider-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const initial = 1_000_000_000_000;

const fixtureConfig = Schema.decodeSync(EnvironmentConfig)({
  kind: "test",
  stage: "test-account-0123456789ab",
  applicationStage: "test-account-0123456789ab",
  senderKind: "synthetic",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel", "fixture_other"],
  twitchClientId: "fixture-twitch",
  discordApplicationId: "fixture-discord",
});

const runtime = RuntimeContext.of({
  Type: "test",
  id: "attribution",
  env: {},
  get: () => Effect.as(Effect.void, undefined),
  set: (key) => Effect.succeed(key),
});

const memory = Effect.fnUntraced(function* () {
  const values = new Map<string, unknown>();
  const lock = yield* Semaphore.make(1);
  let alarm: number | null = null;

  return {
    // SAFETY: This fixture mirrors Cloudflare's generic storage API; callers own
    // the key's type and production readers validate persisted data with schemas.
    get: <T = unknown>(key: string) =>
      Effect.sync(() => structuredClone(values.get(key)) as T | undefined),
    put: <T>(key: string, value: T) =>
      Effect.sync(() => {
        values.set(key, structuredClone(value));
      }),
    // SAFETY: As with native storage, list's generic is supplied by the caller;
    // the fixture preserves the values written under each key without conversion.
    list: <T = unknown>({ prefix }: { prefix: string }) =>
      Effect.sync(
        () =>
          new Map(
            Arr.filter([...values], ([key]) => !!Str.startsWith(prefix)(key)),
          ) as Map<string, T>,
      ),
    delete: (key: string) => Effect.sync(() => values.delete(key)),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const before = structuredClone(values);
        const previousAlarm = alarm;
        const exit = yield* Effect.exit(effect);

        if (Exit.isFailure(exit)) {
          values.clear();

          for (const [key, value] of before) values.set(key, value);
          alarm = previousAlarm;

          return yield* Effect.failCause(exit.cause);
        }

        return exit.value;
      }).pipe((effect) => lock.withPermit(effect)),
    getAlarm: () => Effect.sync(() => alarm),
    setAlarm: (value: number | Date) =>
      Effect.sync(() => {
        alarm = Number(value);
      }),
    deleteAlarm: () =>
      Effect.sync(() => {
        alarm = null;
      }),
  };
});

const providerConfig = {
  clientId: fixtureConfig.twitchClientId,
  clientSecret: Redacted.make("CANARY-CLIENT-SECRET"),
  signingSecret: Redacted.make("CANARY-SIGNING-SECRET"),
  callback: "https://fixture.invalid/webhooks/twitch",
  redirect: "https://fixture.invalid/oauth/twitch/callback",
};

const loopback = Effect.gen(function* () {
  const core = yield* makeProviderFixture(yield* memory(), fixtureConfig);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      const result = await Effect.runPromise(
        core
          .request(
            request.method,
            url.pathname + url.search,
            await request.text(),
            request.headers.get("authorization") ?? "",
          )
          .pipe(Effect.provideService(RuntimeContext, runtime)),
      );

      return Response.json(result.body, { status: result.status });
    },
  });

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));

  return { core, url: server.url.toString() };
});

const actor = Effect.fnUntraced(function* (url: string, start = initial) {
  const storage = yield* memory();
  const store = yield* makeAccountStorage(storage);
  const realClock = yield* Clock.Clock;
  let time = start;
  let instance = "";
  let duplicateHttp = false;

  const clock: Clock.Clock = {
    sleep: (duration) => realClock.sleep(duration),
    monotonicTimeNanos: realClock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
    currentTimeMillis: Effect.sync(() => time),
    currentTimeMillisUnsafe: () => time,
    currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
  };

  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Clock.Clock, clock));

  const providerFor = (
    correlation: Parameters<typeof validationEndpoints>[1],
  ) => {
    const provider = Effect.runSync(
      makeProvider(providerConfig, validationEndpoints(url, correlation)).pipe(
        Effect.provide(providerTransport),
      ),
    );

    return {
      ...provider,
      validate: Effect.fnUntraced(function* (token: string) {
        const value = yield* provider.validate(token);

        if (duplicateHttp) yield* provider.validate(token);

        return value;
      }),
    };
  };

  const construct = Effect.fnUntraced(function* () {
    if (instance)
      yield* recordActivation(storage, {
        kind: "reconstruct",
        instance,
        alarmRun: null,
      });
    instance = yield* secureRandomUUID;
    yield* recordActivation(storage, {
      kind: "activation",
      instance,
      alarmRun: null,
    });

    return yield* run(
      makeAccount({
        identity: fixtureConfig,
        revision: "attribution",
        ...providerConfig,
        webhookReady: true,
        subscriptionBinding: "attribution",
      }).pipe(
        Effect.provideService(AccountStore, store),
        Effect.provideService(
          TwitchProvider,
          yield* observeValidations(providerFor, storage, instance),
        ),
        Effect.provideService(CurrentValidationOrigin, {
          operation: "construction",
          alarmRun: null,
        }),
      ),
    );
  });

  const state = () =>
    storage
      .get("account:shared:v1")
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SharedAccount)),
        Effect.orDie,
      );

  const alarm = Effect.fnUntraced(function* (
    account: Effect.Success<ReturnType<typeof construct>>,
    extraInvocation = false,
  ) {
    const alarmRun =
      ((yield* storage.get<number>("fixtureAlarmRuns")) ?? 0) + 1;

    yield* storage.deleteAlarm();
    const entryAlarm = yield* storage.getAlarm();
    yield* storage.put("fixtureAlarmRuns", alarmRun);
    yield* recordActivation(storage, {
      kind: "alarm-entry",
      instance,
      alarmRun,
    });
    yield* run(
      Effect.gen(function* () {
        yield* account.credentialAlarm;

        if (extraInvocation) {
          const token = (yield* state()).session?.token;

          if (!token) return yield* Effect.die("Missing test credential");

          const provider = yield* observeValidations(
            providerFor,
            storage,
            instance,
          );

          yield* provider.validate(token);
        }
      }),
    ).pipe(
      Effect.provideService(CurrentValidationOrigin, {
        operation: "alarm",
        alarmRun,
      }),
    );

    return yield* recordCompletedAlarm(storage, {
      instance,
      alarmRun,
      entryAlarm,
      accountTime: time,
    });
  });

  return {
    storage,
    state,
    construct,
    alarm,
    run,
    providerFor,
    time: (next: number) => {
      time = next;
    },
    duplicateHttp: (value: boolean) => {
      duplicateHttp = value;
    },
    observations: () => readAccountAttribution(storage),
  };
});

const preparedProof = Effect.fnUntraced(function* (extraEarly = false) {
  const { core, url } = yield* loopback;
  const target = yield* actor(url);
  const original = yield* target.construct();
  yield* target.run(original.service.setup("operator"));
  const preparedInstance = (yield* target.observations()).events[0]?.instance;

  if (!preparedInstance)
    return yield* Effect.die("Missing original activation");
  const leaseUntil = initial + policy.tokenLeaseMs;
  yield* target.storage.put("account:shared:v1", {
    ...(yield* target.state()),
    tokenLease: { owner: "interrupted-fixture", until: leaseUntil },
    nextCredentialCheck: initial + 1500,
  });
  const recovered = yield* target.construct();
  target.time(initial + 1);
  const early = yield* target.alarm(recovered, extraEarly);
  expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(
    extraEarly ? 2 : 1,
  );
  target.time(leaseUntil);

  return { target, recovered, early, core, url, preparedInstance, leaseUntil };
});

const completedProof = Effect.gen(function* () {
  const proof = yield* preparedProof();
  const recovery = yield* proof.target.alarm(proof.recovered);

  const evidence: CompletedRecoveryEvidence = {
    account: yield* proof.target.observations(),
    provider: (yield* proof.core.snapshot()).validations,
    earlyRunKey: proof.early.key,
    recoveryRunKey: recovery.key,
    preparedInstance: proof.preparedInstance,
    leaseUntil: proof.leaseUntil,
  };

  return { ...proof, evidence };
});

const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provideService(RuntimeContext, runtime));

test(
  "completed recovery remains exact after other-account validation and later target reconstruction",
  local(
    Effect.gen(function* () {
      const { target, core, url, evidence } = yield* completedProof;
      const verified = verifyCompletedRecovery(evidence);
      expect(verified.runKey).toBe(evidence.recoveryRunKey);
      expect(
        Arr.map(
          evidence.account.completedRuns,
          (run) => run.validationInvocationIds.length,
        ),
      ).toEqual([0, 1]);
      expect(
        Arr.filter(
          evidence.provider.events,
          (event) =>
            !!(event.correlation?.invocationId === verified.invocationId),
        ),
      ).toHaveLength(1);
      const other = yield* actor(url, initial + 86_400_000);
      const otherOriginal = yield* other.construct();
      yield* other.run(otherOriginal.service.setup("operator"));
      const otherRebuilt = yield* other.construct();
      yield* other.alarm(otherRebuilt);
      expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(4);
      const targetRebuilt = yield* target.construct();
      const later = yield* target.alarm(targetRebuilt);

      const latest = {
        ...evidence,
        account: yield* target.observations(),
        provider: (yield* core.snapshot()).validations,
      };

      expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(5);
      expect(verifyCompletedRecovery(latest)).toEqual(verified);
      expect(
        selectCompletedRun(latest.account, evidence.recoveryRunKey),
      ).toEqual(selectCompletedRun(evidence.account, evidence.recoveryRunKey));
      expect(
        verifyCompletedValidation({ ...latest, runKey: later.key })
          .invocationId,
      ).not.toBe(verified.invocationId);
      expect(later.instance).not.toBe(
        selectCompletedRun(evidence.account, evidence.recoveryRunKey).instance,
      );
      expect(completedRunKey(latest.account, 2)).toBe(evidence.recoveryRunKey);

      const immutable = selectCompletedRun(
        latest.account,
        evidence.recoveryRunKey,
      );

      expect(
        Exit.isFailure(
          yield* Effect.exit(recordCompletedAlarm(target.storage, immutable)),
        ),
      ).toBeTrue();
      expect(yield* target.observations()).toEqual(latest.account);

      const safe = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(latest).pipe(Effect.orDie);

      expect(safe).not.toContain("synthetic-app-");
      expect(safe).not.toContain("CANARY-");
      expect(safe).not.toContain("access_token");
      expect(safe).not.toContain("authorization");
    }),
  ),
);

test(
  "two actual production HTTP validations under one invocation UUID fail completed recovery",
  local(
    Effect.gen(function* () {
      const proof = yield* preparedProof();
      proof.target.duplicateHttp(true);
      const recovery = yield* proof.target.alarm(proof.recovered);
      const account = yield* proof.target.observations();
      const provider = (yield* proof.core.snapshot()).validations;
      const invocationId = recovery.validationInvocationIds[0];
      expect(recovery.validationInvocationIds).toHaveLength(1);
      expect(
        Arr.filter(
          provider.events,
          (event) => !!(event.correlation?.invocationId === invocationId),
        ),
      ).toHaveLength(2);
      expect((yield* proof.core.snapshot()).calls["GET /oauth/validate"]).toBe(
        3,
      );
      expect(() =>
        verifyCompletedRecovery({
          account,
          provider,
          earlyRunKey: proof.early.key,
          recoveryRunKey: recovery.key,
          preparedInstance: proof.preparedInstance,
          leaseUntil: proof.leaseUntil,
        }),
      ).toThrow("wrong actual HTTP count");
    }),
  ),
);

test(
  "two completed invocations with real HTTP in one recovery run fail",
  local(
    Effect.gen(function* () {
      const proof = yield* preparedProof();
      const recovery = yield* proof.target.alarm(proof.recovered, true);
      expect(recovery.validationInvocationIds).toHaveLength(2);
      expect((yield* proof.core.snapshot()).calls["GET /oauth/validate"]).toBe(
        3,
      );
      const account = yield* proof.target.observations();
      const provider = (yield* proof.core.snapshot()).validations;
      expect(() =>
        verifyCompletedRecovery({
          account,
          provider,
          earlyRunKey: proof.early.key,
          recoveryRunKey: recovery.key,
          preparedInstance: proof.preparedInstance,
          leaseUntil: proof.leaseUntil,
        }),
      ).toThrow("wrong invocation count");
    }),
  ),
);

test(
  "an actual early leased alarm with a validation invocation and HTTP fails exact-zero checks",
  local(
    Effect.gen(function* () {
      const proof = yield* preparedProof(true);
      const recovery = yield* proof.target.alarm(proof.recovered);
      const account = yield* proof.target.observations();
      const provider = (yield* proof.core.snapshot()).validations;
      expect(proof.early.validationInvocationIds).toHaveLength(1);
      expect(
        Arr.filter(
          provider.events,
          (event) => !!(event.correlation?.origin.alarmRun === 1),
        ),
      ).toHaveLength(1);
      expect(() =>
        verifyCompletedRecovery({
          account,
          provider,
          earlyRunKey: proof.early.key,
          recoveryRunKey: recovery.key,
          preparedInstance: proof.preparedInstance,
          leaseUntil: proof.leaseUntil,
        }),
      ).toThrow("wrong invocation count");
    }),
  ),
);

test(
  "actual early-run HTTP without an invocation journal record fails closed",
  local(
    Effect.gen(function* () {
      const { target, core, evidence } = yield* completedProof;
      const early = selectCompletedRun(evidence.account, evidence.earlyRunKey);
      const token = (yield* target.state()).session?.token;

      if (!token) return yield* Effect.die("Missing test token");
      yield* target
        .providerFor({
          instance: early.instance,
          origin: { operation: "alarm", alarmRun: 1 },
          invocationId: yield* secureRandomUUID,
        })
        .validate(token);
      const provider = (yield* core.snapshot()).validations;
      expect(
        evidence.account.completedRuns[0]?.validationInvocationIds,
      ).toHaveLength(0);
      expect(
        Arr.filter(
          provider.events,
          (event) => !!(event.correlation?.origin.alarmRun === 1),
        ),
      ).toHaveLength(1);
      expect(() => verifyCompletedRecovery({ ...evidence, provider })).toThrow(
        "wrong actual HTTP count",
      );
    }),
  ),
);

test(
  "missing, ambiguous, truncated, incomplete, and mismatched completed-run evidence fail closed",
  local(
    Effect.gen(function* () {
      const { evidence } = yield* completedProof;

      const recovery = selectCompletedRun(
        evidence.account,
        evidence.recoveryRunKey,
      );

      const id = recovery.validationInvocationIds[0];

      if (!id) return yield* Effect.die("Missing recovery invocation");

      const changeEvent = (
        change: (
          event: (typeof evidence.provider.events)[number],
        ) => (typeof evidence.provider.events)[number],
      ) => ({
        ...evidence,
        provider: {
          ...evidence.provider,
          events: Arr.map(evidence.provider.events, (event) =>
            event.correlation?.invocationId === id ? change(event) : event,
          ),
        },
      });

      const mutations: CompletedRecoveryEvidence[] = [
        {
          ...evidence,
          account: {
            ...evidence.account,
            completedRuns: Arr.filter(
              evidence.account.completedRuns,
              (run) => !!(run.key !== recovery.key),
            ),
          },
        },
        {
          ...evidence,
          account: {
            ...evidence.account,
            completedRuns: [...evidence.account.completedRuns, recovery],
          },
        },
        {
          ...evidence,
          account: {
            ...evidence.account,
            invocations: Arr.filter(
              evidence.account.invocations,
              (invocation) => !!(invocation.id !== id),
            ),
          },
        },
        {
          ...evidence,
          account: {
            ...evidence.account,
            invocations: Arr.map(evidence.account.invocations, (invocation) =>
              invocation.id === id
                ? { ...invocation, completion: null }
                : invocation,
            ),
          },
        },
        {
          ...evidence,
          account: {
            ...evidence.account,
            invocations: Arr.map(evidence.account.invocations, (invocation) =>
              invocation.id === id
                ? {
                    ...invocation,
                    credentialFingerprint: Str.repeat(64)("0"),
                  }
                : invocation,
            ),
          },
        },
        {
          ...evidence,
          provider: {
            ...evidence.provider,
            events: Arr.filter(
              evidence.provider.events,
              (event) => !!(event.correlation?.invocationId !== id),
            ),
          },
        },
        changeEvent((event) => ({ ...event, correlation: null })),
        changeEvent((event) => ({
          ...event,
          correlation: event.correlation && {
            ...event.correlation,
            invocationId: crypto.randomUUID(),
          },
        })),
        changeEvent((event) => ({
          ...event,
          correlation: event.correlation && {
            ...event.correlation,
            instance: crypto.randomUUID(),
          },
        })),
        changeEvent((event) => ({
          ...event,
          correlation: event.correlation && {
            ...event.correlation,
            origin: { operation: "alarm", alarmRun: 3 },
          },
        })),
        changeEvent((event) => ({
          ...event,
          credentialFingerprint: Str.repeat(64)("0"),
        })),
        changeEvent((event) => ({ ...event, correlationError: true })),
      ];

      for (const field of [
        "eventsDropped",
        "invocationsDropped",
        "completedRunsDropped",
        "integrityErrorsDropped",
      ] as const)
        mutations.push({
          ...evidence,
          account: { ...evidence.account, [field]: 1 },
        });

      for (const field of ["eventsDropped", "credentialsDropped"] as const)
        mutations.push({
          ...evidence,
          provider: { ...evidence.provider, [field]: 1 },
        });

      for (const mutation of mutations)
        expect(() => verifyCompletedRecovery(mutation)).toThrow(
          "Completed alarm evidence rejected",
        );
      expect(() =>
        completedRunKey(
          {
            ...evidence.account,
            completedRuns: [
              ...evidence.account.completedRuns,
              { ...recovery, instance: crypto.randomUUID(), key: "different" },
            ],
          },
          2,
        ),
      ).toThrow("ambiguous");
    }),
  ),
);

for (const phase of ["start", "completion"] as const) {
  for (const outcome of [
    "success",
    "failure",
    "defect",
    "interrupted",
  ] as const) {
    test(
      `${phase} diagnostic storage failure preserves provider ${outcome} and rejects evidence`,
      local(
        Effect.gen(function* () {
          const { core, url } = yield* loopback;
          const storage = yield* memory();
          const instance = yield* secureRandomUUID;
          const failure = new AccountError({ code: "provider" });
          const defect = new Error("CANARY-DIAGNOSTIC-DEFECT");
          const entered = yield* Deferred.make<void>();
          let injected = false;

          const brokenStorage = {
            ...storage,
            put: <T>(key: string, value: T) =>
              Effect.suspend(() => {
                if (key === "fixtureAttribution" && !injected) {
                  const journal =
                    Schema.decodeUnknownSync(AccountAttribution)(value);

                  if (
                    journal.invocations.length > 0 &&
                    (phase === "start" ||
                      journal.invocations[0]?.completion !== null)
                  ) {
                    injected = true;

                    return Effect.die("CANARY-STORAGE-FAILURE");
                  }
                }

                return storage.put(key, value);
              }),
          };

          const provider = yield* observeValidations(
            (correlation) => {
              const real = Effect.runSync(
                makeProvider(
                  providerConfig,
                  validationEndpoints(url, correlation),
                ).pipe(Effect.provide(providerTransport)),
              );

              return {
                ...real,
                validate: Effect.fnUntraced(function* (token: string) {
                  const result = yield* real.validate(token);

                  if (outcome === "failure") return yield* failure;

                  if (outcome === "defect") return yield* Effect.die(defect);

                  if (outcome === "interrupted") {
                    yield* Deferred.succeed(entered, undefined);

                    return yield* Effect.never;
                  }

                  return result;
                }),
              };
            },
            brokenStorage,
            instance,
          );

          const validation = provider.validate("synthetic-app-exit-proof").pipe(
            Effect.provideService(CurrentValidationOrigin, {
              operation: "alarm",
              alarmRun: 2,
            }),
          );

          let exit: Exit.Exit<
            Effect.Success<ReturnType<typeof provider.validate>>,
            AccountError
          >;

          if (outcome === "interrupted") {
            const fiber = yield* validation.pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            exit = yield* Fiber.await(fiber);
            expect(Exit.hasInterrupts(exit)).toBeTrue();

            if (Exit.isFailure(exit))
              expect(
                Arr.every(
                  exit.cause.reasons,
                  (reason) => !!Predicate.isTagged(reason, "Interrupt"),
                ),
              ).toBeTrue();
          } else {
            exit = yield* Effect.exit(validation);

            if (outcome === "failure") expect(exit).toEqual(Exit.fail(failure));
            else if (outcome === "defect")
              expect(exit).toEqual(Exit.die(defect));
            else
              expect(exit).toEqual(
                Exit.succeed({
                  client_id: "fixture-twitch",
                  expires_in: 3600,
                  scopes: [],
                }),
              );
          }

          expect(injected).toBeTrue();
          expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(1);
          const account = yield* readAccountAttribution(storage);
          expect(
            Arr.some(
              account.integrityErrors,
              (error) => !!(error.phase === phase),
            ),
          ).toBeTrue();
          const providerEvidence = (yield* core.snapshot()).validations;
          expect(() =>
            verifyCompletedValidation({
              account,
              provider: providerEvidence,
              runKey: `${instance}:2`,
            }),
          ).toThrow("diagnostic storage failure");

          const safe = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(account).pipe(Effect.orDie);

          expect(safe).not.toContain("CANARY-");
          expect(safe).not.toContain("synthetic-app-");
        }),
      ),
    );
  }
}

for (const phase of ["start", "completion"] as const) {
  test(
    `unavailable ${phase} journal and integrity writes preserve actual HTTP and reject incomplete evidence`,
    local(
      Effect.gen(function* () {
        const { target, core, early } = yield* preparedProof();
        let started = false;

        const unavailable = {
          ...target.storage,
          put: <T>(key: string, value: T) =>
            Effect.suspend(() => {
              if (phase === "completion" && !started) {
                started = true;

                return target.storage.put(key, value);
              }

              return Effect.die("CANARY-UNAVAILABLE-JOURNAL");
            }),
        };

        const provider = yield* observeValidations(
          target.providerFor,
          unavailable,
          early.instance,
        );

        const token = (yield* target.state()).session?.token;

        if (!token) return yield* Effect.die("Missing test token");
        yield* recordActivation(target.storage, {
          kind: "alarm-entry",
          instance: early.instance,
          alarmRun: 2,
        });

        const exit = yield* Effect.exit(
          provider.validate(token).pipe(
            Effect.provideService(CurrentValidationOrigin, {
              operation: "alarm",
              alarmRun: 2,
            }),
          ),
        );

        expect(Exit.isSuccess(exit)).toBeTrue();

        const completed = yield* recordCompletedAlarm(target.storage, {
          instance: early.instance,
          alarmRun: 2,
          entryAlarm: null,
          accountTime: initial + policy.tokenLeaseMs,
        });

        const account = yield* target.observations();
        const providerEvidence = (yield* core.snapshot()).validations;
        expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(2);
        expect(account.integrityErrors).toHaveLength(0);
        expect(() =>
          verifyCompletedValidation({
            account,
            provider: providerEvidence,
            runKey: completed.key,
          }),
        ).toThrow(
          phase === "start"
            ? "wrong invocation count"
            : "incomplete or unsuccessful invocation",
        );
      }),
    ),
  );
}

test(
  "malformed correlation reaches the fixture boundary, preserves its HTTP response, and fails closed",
  local(
    Effect.gen(function* () {
      const { target, core, url, evidence } = yield* completedProof;
      const token = (yield* target.state()).session?.token;

      if (!token) return yield* Effect.die("Missing test token");

      const recovery = selectCompletedRun(
        evidence.account,
        evidence.recoveryRunKey,
      );

      const response = yield* Effect.promise(() =>
        fetch(
          `${url}fixture-validation/${recovery.instance}/alarm/2/missing-uuid/oauth/validate`,
          { headers: { authorization: `OAuth ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const provider = (yield* core.snapshot()).validations;
      expect(provider.events.at(-1)?.correlationError).toBeTrue();
      expect(() => verifyCompletedRecovery({ ...evidence, provider })).toThrow(
        "invalid HTTP correlation",
      );
    }),
  ),
);

test(
  "completed runs, invocations, activations, and actual HTTP events are bounded with dropped totals",
  local(
    Effect.gen(function* () {
      const { target, core, evidence } = yield* completedProof;
      const account = yield* target.construct();

      for (let i = 0; i < attributionLimit + 3; i++) {
        yield* target.alarm(account, true);
        yield* recordActivation(target.storage, {
          kind: "build",
          instance: yield* secureRandomUUID,
          alarmRun: null,
        });
      }

      const journal = yield* target.observations();
      const provider = (yield* core.snapshot()).validations;
      expect(journal.completedRuns).toHaveLength(attributionLimit);
      expect(journal.completedRunsDropped).toBe(5);
      expect(journal.invocations).toHaveLength(attributionLimit);
      expect(journal.invocationsDropped).toBeGreaterThan(0);
      expect(journal.events).toHaveLength(attributionLimit);
      expect(journal.eventsDropped).toBeGreaterThan(0);
      expect(provider.events).toHaveLength(attributionLimit);
      expect(provider.eventsDropped).toBeGreaterThan(0);
      expect(() =>
        verifyCompletedRecovery({ ...evidence, account: journal, provider }),
      ).toThrow("truncated journal");

      for (let i = 0; i < attributionLimit + 3; i++)
        yield* core.request(
          "GET",
          "/oauth/validate",
          "",
          `OAuth synthetic-app-bounded-${i}`,
        );
      const credentials = (yield* core.snapshot()).validations;
      expect(Rec.keys(credentials.counts)).toHaveLength(attributionLimit);
      expect(credentials.credentialsDropped).toBe(4);
      expect(yield* credentialFingerprint("CANARY-TOKEN")).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }),
  ),
);
