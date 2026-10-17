import { expect } from "bun:test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Semaphore,
} from "effect";
import { makeAccountStorage } from "../../apps/bot/src/twitch.js";
import { makeAccount } from "../../apps/bot/src/twitch-account.js";
import { AccountError } from "../../apps/bot/src/twitch-contracts.js";
import {
  makeProvider,
  TwitchProvider,
} from "../../apps/bot/src/twitch-provider.js";
import {
  AccountState,
  AccountStore,
  policy,
} from "../../apps/bot/src/twitch-state.js";
import {
  fixtureConfig,
  initial,
} from "../../apps/bot/test/twitch-account-fixture.js";
import {
  attributionLimit,
  CurrentValidationOrigin,
  credentialFingerprint,
  observeValidations,
  readAccountAttribution,
  recordActivation,
} from "./alarm-attribution.js";
import { makeProviderFixture } from "./twitch-provider-fixture.js";

const { test } = Test.make({ providers: Layer.empty });
const runtime = RuntimeContext.of({
  Type: "test",
  id: "attribution",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});
const memory = Effect.fnUntraced(function* () {
  const values = new Map<string, unknown>();
  const lock = yield* Semaphore.make(1);
  let alarm: number | null = null;
  return {
    get: <T = unknown>(key: string) =>
      Effect.sync(() => structuredClone(values.get(key)) as T | undefined),
    put: (key: string, value: unknown) =>
      Effect.sync(() => {
        values.set(key, structuredClone(value));
      }),
    list: <T = unknown>({ prefix }: { prefix: string }) =>
      Effect.sync(
        () =>
          new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<
            string,
            T
          >,
      ),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(lock.withPermit),
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

test(
  "HTTP observations distinguish another account from a second target activation",
  Effect.gen(function* () {
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
    const realClock = yield* Clock.Clock;
    const create = Effect.fnUntraced(function* (actor: string, start: number) {
      const storage = yield* memory();
      const store = yield* makeAccountStorage(storage);
      let time = start;
      let runs = 0;
      let instance = "";
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
      const provider = makeProvider(providerConfig, {
        oauth: `${server.url}oauth`,
        api: `${server.url}helix`,
      });
      const construct = Effect.fnUntraced(function* () {
        if (instance)
          yield* recordActivation(storage, {
            kind: "reconstruct",
            instance,
            alarmRun: null,
          });
        instance = `${actor}-${crypto.randomUUID()}`;
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
              yield* observeValidations(provider, storage, instance),
            ),
          ),
        );
      });
      const alarm = Effect.fnUntraced(function* (
        account: Effect.Success<ReturnType<typeof construct>>,
      ) {
        runs++;
        yield* storage.deleteAlarm();
        yield* recordActivation(storage, {
          kind: "alarm-entry",
          instance,
          alarmRun: runs,
        });
        yield* run(account.credentialAlarm()).pipe(
          Effect.provideService(CurrentValidationOrigin, {
            operation: "alarm",
            alarmRun: runs,
          }),
        );
        yield* recordActivation(storage, {
          kind: "alarm-complete",
          instance,
          alarmRun: runs,
        });
      });
      return {
        storage,
        construct,
        alarm,
        run,
        time: (next: number) => {
          time = next;
        },
        state: () =>
          storage
            .get("account:v1")
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(AccountState)),
              Effect.orDie,
            ),
        observations: () => readAccountAttribution(storage),
      };
    });
    const target = yield* create("target", initial);
    const original = yield* target.construct();
    yield* target.run(original.service.setup("operator"));
    const other = yield* create("other", initial + 86_400_000);
    const otherOriginal = yield* other.construct();
    yield* other.run(otherOriginal.service.setup("operator"));
    const before = yield* core.snapshot();
    const until = initial + policy.tokenLeaseMs;
    yield* target.storage.put("account:v1", {
      ...(yield* target.state()),
      tokenLease: { owner: "interrupted-fixture", until },
      nextCredentialCheck: initial + 1500,
    });
    const recovered = yield* target.construct();
    target.time(initial + 1);
    yield* target.alarm(recovered);
    expect((yield* core.snapshot()).calls["GET /oauth/validate"]).toBe(2);
    expect((yield* target.state()).nextCredentialCheck).toBe(until);
    target.time(until);
    yield* target.alarm(recovered);
    const completed = yield* target.observations();
    const targetFingerprint = completed.invocations[0]?.credentialFingerprint;
    const otherFingerprint = (yield* other.observations()).invocations[0]
      ?.credentialFingerprint;
    if (!targetFingerprint || !otherFingerprint)
      return yield* Effect.die("Missing invocation evidence");
    expect(targetFingerprint).not.toBe(otherFingerprint);
    expect((yield* target.state()).tokenLease).toBeNull();
    expect((yield* target.state()).nextCredentialCheck ?? 0).toBeGreaterThan(
      until,
    );
    expect((yield* core.snapshot()).validations.counts).toEqual({
      [targetFingerprint]: 2,
      [otherFingerprint]: 1,
    });
    const otherRebuilt = yield* other.construct();
    yield* other.alarm(otherRebuilt);
    const contaminated = yield* core.snapshot();
    expect(contaminated.calls["GET /oauth/validate"]).toBe(
      (before.calls["GET /oauth/validate"] ?? 0) + 2,
    );
    expect(contaminated.validations.counts).toEqual({
      [targetFingerprint]: 2,
      [otherFingerprint]: 2,
    });
    const targetRebuilt = yield* target.construct();
    yield* target.alarm(targetRebuilt);
    const final = yield* core.snapshot();
    const targetRecords = yield* target.observations();
    expect(final.validations.counts).toEqual({
      [targetFingerprint]: 3,
      [otherFingerprint]: 2,
    });
    expect(
      targetRecords.invocations.map((record) => record.origin.alarmRun),
    ).toEqual([null, 2, 3]);
    expect(targetRecords.invocations[1]?.instance).not.toBe(
      targetRecords.invocations[2]?.instance,
    );
    expect(completed.invocations).toHaveLength(2);
    expect(
      targetRecords.invocations.every(
        (record) => record.completion?.outcome === "success",
      ),
    ).toBeTrue();
    expect(final.validations.events.map((event) => event.globalCount)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    const safe = JSON.stringify({
      final,
      targetRecords,
      other: yield* other.observations(),
    });
    expect(safe).not.toContain("synthetic-app-");
    expect(safe).not.toContain("CANARY-");
    expect(safe).not.toContain("access_token");
  }).pipe(Effect.scoped, Effect.provideService(RuntimeContext, runtime)),
);

test(
  "validation records preserve failure and interruption and bound retained HTTP evidence",
  Effect.gen(function* () {
    const storage = yield* memory();
    const core = yield* makeProviderFixture(yield* memory(), fixtureConfig);
    const base = makeProvider(providerConfig);
    const failure = new AccountError({ code: "provider" });
    const rejected = yield* observeValidations(
      { ...base, validate: () => failure },
      storage,
      "failed",
    );
    expect(yield* Effect.exit(rejected.validate("CANARY-REJECTED"))).toEqual(
      Exit.fail(failure),
    );
    const entered = yield* Deferred.make<void>();
    const held = yield* observeValidations(
      {
        ...base,
        validate: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
      },
      storage,
      "interrupted",
    );
    const fiber = yield* held
      .validate("CANARY-INTERRUPTED")
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBeTrue();
    const observations = yield* readAccountAttribution(storage);
    expect(
      observations.invocations.map((record) => record.completion?.outcome),
    ).toEqual(["failure", "interrupted"]);
    for (let i = 0; i < attributionLimit + 3; i++) {
      yield* core.request(
        "GET",
        "/oauth/validate",
        "",
        `OAuth synthetic-app-${i}`,
      );
      yield* recordActivation(storage, {
        kind: "activation",
        instance: `activation-${i}`,
        alarmRun: null,
      });
    }
    for (let i = 0; i < attributionLimit + 3; i++)
      yield* Effect.exit(rejected.validate("CANARY-REJECTED"));
    const bounded = yield* readAccountAttribution(storage);
    expect(bounded.invocations).toHaveLength(attributionLimit);
    expect(bounded.invocationsDropped).toBe(5);
    const final = yield* core.snapshot();
    expect(final.calls["GET /oauth/validate"]).toBe(attributionLimit + 3);
    expect(final.validations.events).toHaveLength(attributionLimit);
    expect(Object.keys(final.validations.counts)).toHaveLength(
      attributionLimit,
    );
    expect(final.validations.eventsDropped).toBe(3);
    expect(final.validations.credentialsDropped).toBe(3);
    expect(
      final.validations.counts[
        yield* credentialFingerprint(`synthetic-app-${attributionLimit + 2}`)
      ],
    ).toBe(1);
    expect((yield* readAccountAttribution(storage)).eventsDropped).toBe(3);
    expect(JSON.stringify({ final, observations })).not.toContain("CANARY-");
  }).pipe(Effect.provideService(RuntimeContext, runtime)),
);
