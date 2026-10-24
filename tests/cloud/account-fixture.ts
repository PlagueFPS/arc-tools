import * as Cloudflare from "@alchemy.run/cloudflare";
import { AccountRpc, accountRpcLayer } from "@arctools/twitch/cloudflare";
import {
  subscriptionBinding,
  Dispatch,
  OAuthCompletion,
  SubscriptionObservation,
} from "@arctools/twitch/server";
import {
  TwitchProvider,
  providerLayer,
  SharedAccount,
  policy,
} from "@arctools/twitch/testing";
import { providerTransport } from "@arctools/utils/http";
import { Stack } from "alchemy";
import { Cause, Clock, Effect, Layer, Logger, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { EnvironmentConfig, runtimeConfig } from "../../apps/bot/src/config.js";
import {
  CurrentValidationOrigin,
  observeValidations,
  readAccountAttribution,
  recordActivation,
  recordCompletedAlarm,
  validationEndpoints,
} from "./alarm-attribution.js";
import {
  acknowledgeReconstruction,
  identifyFixtureResponse,
} from "./fixture-response.js";
import { TwitchProviderFixture } from "./twitch-provider-fixture.js";

const Configure = Schema.Struct({
  revision: Schema.String,
  channels: Schema.NonEmptyArray(Schema.String),
});

export class AccountFixtureObject extends Cloudflare.DurableObject<AccountFixtureObject>()(
  "AccountFixture",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    const source = yield* Cloudflare.Worker(
      TwitchProviderFixture.LogicalId,
      {},
    );

    const sourceUrl = yield* source.url;
    const config = yield* runtimeConfig.pipe(Effect.orDie);

    return Effect.gen(function* () {
      const instance = crypto.randomUUID();

      const event = (
        kind: Parameters<typeof recordActivation>[1]["kind"],
        alarmRun: number | null = null,
      ) => recordActivation(state.storage, { kind, instance, alarmRun });

      yield* event("activation");
      const logs: string[] = [];

      const logger = Logger.make((options) => {
        logs.push(
          JSON.stringify({
            message: options.message,
            cause: Cause.pretty(options.cause),
          }),
        );

        if (logs.length > 128) logs.shift();
      });

      const baseUrl = yield* sourceUrl;

      if (!Schema.is(Schema.String)(baseUrl))
        return yield* Effect.die("Provider fixture URL unavailable");
      const realClock = yield* Clock.Clock;

      let time =
        (yield* state.storage.get<number>("fixtureTime")) ?? Date.now();

      let realtime =
        (yield* state.storage.get<boolean>("fixtureRealtime")) ?? false;

      const now = () => (realtime ? Date.now() : time);

      const clock: Clock.Clock = {
        currentTimeMillis: Effect.sync(now),
        currentTimeMillisUnsafe: now,
        currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
        currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
        monotonicTimeNanos: realClock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
        sleep: (duration) => realClock.sleep(duration),
      };

      const build = Effect.fnUntraced(function* () {
        yield* event("build");

        const override = (yield* state.storage.get<typeof Configure.Type>(
          "fixtureConfig",
        )) ?? {
          revision: "fixture-revision",
          channels: ["fixture_channel", "fixture_other"],
        };

        const identity = yield* Schema.decodeUnknownEffect(EnvironmentConfig)({
          ...config.identity,
          channelLogins: override.channels,
        }).pipe(Effect.orDie);

        const callback = "https://fixture.invalid/webhooks/twitch";
        const redirect = "https://fixture.invalid/oauth/twitch/callback";

        const providerFor = (
          correlation: Parameters<typeof validationEndpoints>[1],
        ) =>
          Effect.runSync(
            TwitchProvider.pipe(
              Effect.provide(
                providerLayer(
                  {
                    clientId: identity.twitchClientId,
                    clientSecret: Redacted.make("CANARY-CLIENT-SECRET"),
                    signingSecret: Redacted.make("CANARY-SIGNING-SECRET"),
                    callback,
                    redirect,
                  },
                  validationEndpoints(baseUrl, correlation),
                ).pipe(Layer.provide(providerTransport)),
              ),
            ),
          );

        return yield* AccountRpc.pipe(
          Effect.provide(
            accountRpcLayer(
              {
                identity,
                revision: override.revision,
                callback,
                redirect,
                webhookReady: true,
                subscriptionBinding: yield* subscriptionBinding({
                  callback,
                  clientId: identity.twitchClientId,
                  signingSecret: Redacted.make("CANARY-SIGNING-SECRET"),
                }),
              },
              yield* observeValidations(providerFor, state.storage, instance),
            ),
          ),
        );
      });

      let account = yield* build().pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(CurrentValidationOrigin, {
          operation: "construction",
          alarmRun: null,
        }),
      );

      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );

      return {
        setup: () => run(account.setup("fixture-operator-digest")),
        status: () => run(account.status()),
        complete: (input: OAuthCompletion) => run(account.completeOAuth(input)),
        dispatch: (input: Dispatch) => run(account.dispatch(input)),
        observe: (input: SubscriptionObservation) =>
          run(account.observeSubscription(input)),
        credential: () =>
          run(account.alarm()).pipe(
            Effect.provideService(CurrentValidationOrigin, {
              operation: "credential",
              alarmRun: null,
            }),
          ),
        alarm: Effect.fnUntraced(function* () {
          const entryAlarm = yield* state.storage.getAlarm();

          const runs =
            ((yield* state.storage.get<number>("fixtureAlarmRuns")) ?? 0) + 1;

          yield* state.storage.put("fixtureAlarmRuns", runs);
          yield* event("alarm-entry", runs);
          yield* run(account.alarm()).pipe(
            Effect.provideService(CurrentValidationOrigin, {
              operation: "alarm",
              alarmRun: runs,
            }),
          );
          yield* recordCompletedAlarm(state.storage, {
            instance,
            alarmRun: runs,
            entryAlarm,
            accountTime: now(),
          });
        }),
        prepareNativeAlarm: Effect.fnUntraced(function* () {
          realtime = true;
          yield* state.storage.put("fixtureRealtime", true);
          const setup = yield* run(account.setup("fixture-operator-digest"));

          if (setup.kind !== "success")
            return yield* Effect.die("Native alarm setup failed");
          const until = Date.now() + policy.tokenLeaseMs;
          yield* state.storage
            .transaction(
              Effect.gen(function* () {
                const raw =
                  yield* state.storage.get<unknown>("account:shared:v1");

                const record = yield* Schema.decodeUnknownEffect(SharedAccount)(
                  raw,
                ).pipe(Effect.orDie);

                const intended = Date.now() + 1_500;
                yield* state.storage.put("account:shared:v1", {
                  ...record,
                  tokenLease: { owner: "interrupted-fixture", until },
                  nextCredentialCheck: intended,
                });
                yield* state.storage.setAlarm(intended);
              }),
            )
            .pipe(Effect.orDie);

          return { instance, until };
        }),
        nativeAlarmSnapshot: Effect.fnUntraced(function* () {
          return yield* state.storage
            .transaction(
              Effect.gen(function* () {
                const raw =
                  yield* state.storage.get<unknown>("account:shared:v1");

                const record = yield* Schema.decodeUnknownEffect(SharedAccount)(
                  raw,
                ).pipe(Effect.orDie);

                return {
                  instance,
                  capturedAt: Date.now(),
                  liveAlarmRuns:
                    (yield* state.storage.get<number>("fixtureAlarmRuns")) ?? 0,
                  attribution: yield* readAccountAttribution(state.storage),
                  intended: record.nextCredentialCheck,
                  native: yield* state.storage.getAlarm(),
                  lease: record.tokenLease,
                };
              }),
            )
            .pipe(Effect.orDie);
        }),
        attribution: () =>
          state.storage
            .transaction(
              readAccountAttribution(state.storage).pipe(
                Effect.map((attribution) => ({ instance, attribution })),
              ),
            )
            .pipe(Effect.orDie),
        time: Effect.fnUntraced(function* (next: number) {
          time = next;
          yield* state.storage.put("fixtureTime", next);
        }),
        configure: Effect.fnUntraced(function* (input: typeof Configure.Type) {
          yield* state.storage.put("fixtureConfig", input);
          account = yield* build().pipe(
            Effect.provideService(Cloudflare.DurableObjectState, state),
            Effect.provideService(Clock.Clock, clock),
            Effect.provideService(CurrentValidationOrigin, {
              operation: "construction",
              alarmRun: null,
            }),
          );
        }),
        snapshot: Effect.fnUntraced(function* () {
          const records = yield* state.storage.list({ prefix: "account:" });
          const serialized = JSON.stringify([...records]);

          return {
            instance,
            time,
            logs,
            status: yield* run(account.status()),
            onboardingRetained:
              serialized.includes("CANARY-USER-REFRESH") ||
              serialized.includes("clientId"),
            alarm: yield* state.storage.getAlarm(),
          };
        }),
        reconstruct: Effect.fnUntraced(function* () {
          yield* event("reconstruct");
          yield* state.storage.sync();
          yield* state.abort("account reconstruction fixture");
        }),
      };
    });
  }),
) {}

class AccountApi extends HttpApi.make("account-fixture").add(
  HttpApiGroup.make("account").add(
    HttpApiEndpoint.post("setup", "/setup"),
    HttpApiEndpoint.get("status", "/status"),
    HttpApiEndpoint.post("complete", "/complete"),
    HttpApiEndpoint.post("dispatch", "/dispatch"),
    HttpApiEndpoint.post("observe", "/observe"),
    HttpApiEndpoint.post("time", "/time"),
    HttpApiEndpoint.post("configure", "/configure"),
    HttpApiEndpoint.post("reconstruct", "/reconstruct"),
    HttpApiEndpoint.get("snapshot", "/snapshot"),
    HttpApiEndpoint.get("attribution", "/attribution"),
    HttpApiEndpoint.post("credential", "/credential"),
    HttpApiEndpoint.post("nativePrepare", "/native-alarm/prepare"),
    HttpApiEndpoint.post("nativeReconstruct", "/native-alarm/reconstruct"),
    HttpApiEndpoint.get("nativeSnapshot", "/native-alarm/snapshot"),
  ),
) {}

export class AccountFixtureWorker extends Cloudflare.Worker<AccountFixtureWorker>()(
  "AccountFixtureWorker",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-account-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const objects = yield* AccountFixtureObject;
    const object = () => objects.getByName("environment");
    const nativeObject = () => objects.getByName("native-alarm");

    const json = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.map(HttpServerResponse.jsonUnsafe));

    const input = Effect.fnUntraced(function* <A, I>(
      request: import("effect/http/HttpServerRequest").HttpServerRequest,
      schema: Schema.Codec<A, I>,
    ) {
      return yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.orDie,
      );
    });

    const handlers = HttpApiBuilder.group(AccountApi, "account", (handlers) =>
      handlers
        .handleRaw("setup", () => json(object().setup()))
        .handleRaw("status", () => json(object().status()))
        .handleRaw("snapshot", () => json(object().snapshot()))
        .handleRaw("attribution", () => json(object().attribution()))
        .handleRaw("nativePrepare", () =>
          json(nativeObject().prepareNativeAlarm()).pipe(
            Effect.tapCause((cause) =>
              Effect.logError(
                "Native account fixture preparation failed",
                cause,
              ),
            ),
          ),
        )
        .handleRaw("nativeSnapshot", () =>
          json(nativeObject().nativeAlarmSnapshot()),
        )
        .handleRaw("nativeReconstruct", () =>
          acknowledgeReconstruction(
            nativeObject().reconstruct(),
            "account reconstruction fixture",
          ),
        )
        .handleRaw("complete", ({ request }) =>
          input(request, OAuthCompletion).pipe(
            Effect.flatMap((value) => json(object().complete(value))),
          ),
        )
        .handleRaw("dispatch", ({ request }) =>
          input(request, Dispatch).pipe(
            Effect.flatMap((value) => json(object().dispatch(value))),
          ),
        )
        .handleRaw("observe", ({ request }) =>
          input(request, SubscriptionObservation).pipe(
            Effect.flatMap((value) => json(object().observe(value))),
          ),
        )
        .handleRaw("time", ({ request }) =>
          input(request, Schema.Int).pipe(
            Effect.flatMap((value) => object().time(value)),
            Effect.as(HttpServerResponse.empty({ status: 204 })),
          ),
        )
        .handleRaw("configure", ({ request }) =>
          input(request, Configure).pipe(
            Effect.flatMap((value) => object().configure(value)),
            Effect.as(HttpServerResponse.empty({ status: 204 })),
          ),
        )
        .handleRaw("credential", () =>
          object()
            .credential()
            .pipe(Effect.as(HttpServerResponse.empty({ status: 204 }))),
        )
        .handleRaw("reconstruct", () =>
          acknowledgeReconstruction(
            object().reconstruct(),
            "account reconstruction fixture",
          ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(AccountApi).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          handler.pipe(Effect.map(identifyFixtureResponse)),
        ),
      ),
    };
  }),
) {}

export default AccountFixtureWorker;
