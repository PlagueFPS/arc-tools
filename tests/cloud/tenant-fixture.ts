import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  AccountError,
  DispatchOutcome,
  OAuthCompletion,
  SubscriptionObservation,
  TwitchAccount,
} from "@arctools/twitch/server";
import { Stack } from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Exit, Layer, Schema, Struct } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { runtimeConfig } from "../../apps/bot/src/config.js";
import {
  DiscordReceipt,
  TwitchReceipt,
} from "../../apps/bot/src/tenant-contracts.js";
import { TenantState, TenantStore } from "../../apps/bot/src/tenant-state.js";
import {
  tenantStorageLayer,
  TenantService,
  tenantServiceLayer,
} from "../../apps/bot/src/tenant.js";
import type { TwitchAccountDO } from "../../apps/bot/src/twitch.js";
import { Bot } from "../../apps/bot/src/worker.js";
import {
  ArcCacheDO,
  bindData,
  CacheSource,
} from "../../packages/arc-data/src/cloudflare.js";
import { ArcData } from "../../packages/arc-data/src/data-service.js";
import { botTestBindings } from "./bot-composition.js";
import {
  acknowledgeReconstruction,
  identifyFixtureResponse,
} from "./fixture-response.js";
import { journeyUrl } from "./fixture-routing.js";
import { MetaforgeWorker } from "./metaforge.js";

const AlarmActivity = Schema.Struct({
  instance: Schema.String,
  run: Schema.Int,
});

const CompletedAlarmActivity = Schema.Struct({
  ...AlarmActivity.fields,
  workIds: Schema.Array(Schema.String),
});

export const TenantSnapshot = Schema.Struct({
  instance: Schema.String,
  state: Schema.NullOr(TenantState),
  alarm: Schema.NullOr(Schema.Number),
  alarmRuns: Schema.Int,
  alarmActivity: Schema.Struct({
    running: Schema.NullOr(AlarmActivity),
    completed: Schema.NullOr(CompletedAlarmActivity),
  }),
  lostAccountResponseAt: Schema.NullOr(Schema.Number),
});

const AccountReference = Cloudflare.DurableObject<
  TwitchAccountDO,
  TwitchAccountDO
>()("TwitchAccount");

const Control = Schema.Struct({
  immediate: Schema.optional(Schema.Boolean),
  loseAccountResponse: Schema.optional(Schema.Boolean),
});

class TenantFixtureObject extends Cloudflare.DurableObject<TenantFixtureObject>()(
  "TenantFixture",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const source = yield* Cloudflare.Worker(MetaforgeWorker.LogicalId, {});
    const sourceUrl = yield* source.url;

    const dataClient = yield* bindData.pipe(
      Effect.provideService(CacheSource, {
        options: Effect.gen(function* () {
          const baseUrl = yield* sourceUrl;

          if (!Schema.is(Schema.String)(baseUrl))
            return yield* Effect.die("No fixture source URL");

          return { baseUrl: journeyUrl(baseUrl, "bot") };
        }),
      }),
    );

    const { stage } = yield* Stack;
    const accounts = yield* AccountReference.from(`arc-tools-bot-${stage}`);

    return Effect.gen(function* () {
      const instance = crypto.randomUUID();
      let runningAlarm: typeof AlarmActivity.Type | null = null;

      let liveAlarmRun =
        (yield* state.storage.get<number>("fixtureAlarms")) ?? 0;

      const runtime = yield* RuntimeContext;

      const provide = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
        effect.pipe(Effect.provideService(RuntimeContext, runtime));

      const data = yield* dataClient;

      const store = yield* TenantStore.pipe(
        Effect.provide(tenantStorageLayer(state.storage)),
      );

      const account = TwitchAccount.of({
        dispatch: Effect.fnUntraced(
          function* (input) {
            const raw = yield* provide(
              accounts.getByName("environment").dispatch(input),
            ).pipe(
              Effect.mapError(() => new AccountError({ code: "provider" })),
            );

            const reply = yield* Schema.decodeUnknownEffect(
              Schema.Union([
                Schema.Struct({
                  kind: Schema.Literal("success"),
                  value: DispatchOutcome,
                }),
                Schema.Struct({
                  kind: Schema.Literal("failure"),
                  code: AccountError.fields.code,
                }),
              ]),
            )(raw).pipe(
              Effect.mapError(() => new AccountError({ code: "provider" })),
            );

            if (reply.kind === "failure")
              return yield* new AccountError({ code: reply.code });

            const control =
              (yield* state.storage.get<typeof Control.Type>(
                "fixtureControl",
              )) ?? {};

            if (control.loseAccountResponse && reply.value.kind === "sent") {
              yield* state.storage.put("fixtureLostAt", Date.now());
              yield* state.storage.put("fixtureControl", {
                ...control,
                loseAccountResponse: false,
              });

              return yield* new AccountError({ code: "provider" });
            }

            return reply.value;
          },
          (effect) => provide(effect),
        ),
        status: () => new AccountError({ code: "configuration" }),
        setup: () => new AccountError({ code: "configuration" }),
        completeOAuth: () => new AccountError({ code: "configuration" }),
        observeSubscription: () => Effect.succeed(null),
      });

      const tenant = yield* TenantService.pipe(
        Effect.provide(
          tenantServiceLayer({
            activation: instance,
            launch: Effect.fnUntraced(
              function* (effect) {
                const control =
                  yield* state.storage.get<typeof Control.Type>(
                    "fixtureControl",
                  );

                if (control?.immediate) yield* state.waitUntil(effect);
              },
              (effect) => provide(effect),
            ),
          }),
        ),
      ).pipe(
        Effect.provideService(TenantStore, store),
        Effect.provideService(ArcData, data),
        Effect.provideService(TwitchAccount, account),
        Effect.provideService(RuntimeContext, runtime),
      );

      return {
        source: (input: SubscriptionObservation) =>
          provide(accounts.getByName("environment").observeSubscription(input)),
        accept: (input: TwitchReceipt) =>
          tenant.acceptTwitch(input).pipe(Effect.orDie),
        discord: (input: DiscordReceipt) =>
          tenant.respondDiscord(input).pipe(Effect.orDie),
        control: (input: typeof Control.Type) =>
          state.storage.put("fixtureControl", input),
        recover: () => tenant.recover(),
        snapshot: Effect.fnUntraced(function* () {
          return {
            instance,
            alarmActivity: {
              running: runningAlarm,
              completed:
                (yield* state.storage.get<typeof CompletedAlarmActivity.Type>(
                  "fixtureAlarmCompleted",
                )) ?? null,
            },
            lostAccountResponseAt:
              (yield* state.storage.get<number>("fixtureLostAt")) ?? null,
            state: (yield* state.storage.get("tenant:v1")) ?? null,
            alarm: yield* state.storage.getAlarm(),
            alarmRuns: (yield* state.storage.get<number>("fixtureAlarms")) ?? 0,
          };
        }),
        reconstruct: Effect.fnUntraced(function* () {
          yield* state.storage.sync();
          yield* state.abort("tenant reconstruction fixture");
        }),
        alarm: Effect.fnUntraced(function* () {
          runningAlarm = { instance, run: ++liveAlarmRun };
          yield* Effect.gen(function* () {
            yield* state.storage.put("fixtureAlarms", liveAlarmRun);
            yield* tenant.recover();
          }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (Exit.isSuccess(exit)) {
                  const persisted =
                    yield* state.storage.get<TenantState>("tenant:v1");

                  yield* state.storage.put("fixtureAlarmCompleted", {
                    ...runningAlarm,
                    workIds: Object.keys(persisted?.works ?? {}),
                  });
                }

                runningAlarm = null;
              }),
            ),
          );
        }),
      };
    });
  }),
) {}

class TenantFixtureApi extends HttpApi.make("tenant-fixture").add(
  HttpApiGroup.make("tenant").add(
    HttpApiEndpoint.post("operatorOAuth", "/operator-oauth"),
    HttpApiEndpoint.post("accept", "/accept"),
    HttpApiEndpoint.post("source", "/source"),
    HttpApiEndpoint.post("discord", "/discord"),
    HttpApiEndpoint.post("control", "/control"),
    HttpApiEndpoint.post("recover", "/recover"),
    HttpApiEndpoint.post("reconstruct", "/reconstruct"),
    HttpApiEndpoint.get("snapshot", "/snapshot"),
  ),
) {}

export class TenantFixtureWorker extends Cloudflare.Worker<TenantFixtureWorker>()(
  "TenantFixtureWorker",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-tenant-${stage}`,
      env: {
        ARC_FIXTURE_BOT_WORKER: (yield* Cloudflare.Worker(Bot.LogicalId, {}))
          .workerName,
      },
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    yield* ArcCacheDO.pipe(
      Effect.provide(yield* botTestBindings((yield* runtimeConfig).identity)),
    );
    const bot = yield* Cloudflare.Workers.bindWorker(Bot);
    const objects = yield* TenantFixtureObject;
    const object = (name: string) => objects.getByName(name);

    const input = Effect.fnUntraced(function* <A, I>(
      request: import("effect/http/HttpServerRequest").HttpServerRequest,
      schema: Schema.Codec<A, I>,
    ) {
      return yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.orDie,
      );
    });

    const handlers = HttpApiBuilder.group(
      TenantFixtureApi,
      "tenant",
      (handlers) =>
        handlers
          .handleRaw("source", ({ request }) =>
            input(request, SubscriptionObservation).pipe(
              Effect.flatMap((value) => object("source-driver").source(value)),
              Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
            ),
          )
          .handleRaw("operatorOAuth", ({ request }) =>
            input(
              request,
              OAuthCompletion.mapFields(Struct.omit(["operator"])),
            ).pipe(
              Effect.flatMap(bot.completeOperatorOAuth),
              Effect.as(HttpServerResponse.jsonUnsafe({ completed: true })),
              Effect.orDie,
            ),
          )
          .handleRaw("snapshot", ({ request }) => {
            const key =
              new URL(request.url, "https://fixture.invalid").searchParams.get(
                "key",
              ) ?? "environment";

            return object(key)
              .snapshot()
              .pipe(Effect.map(HttpServerResponse.jsonUnsafe));
          })
          .handleRaw("accept", ({ request }) =>
            input(
              request,
              Schema.Struct({ key: Schema.String, receipt: TwitchReceipt }),
            ).pipe(
              Effect.flatMap(({ key, receipt }) => object(key).accept(receipt)),
              Effect.as(HttpServerResponse.empty({ status: 204 })),
            ),
          )
          .handleRaw("discord", ({ request }) =>
            input(
              request,
              Schema.Struct({ key: Schema.String, receipt: DiscordReceipt }),
            ).pipe(
              Effect.flatMap(({ key, receipt }) =>
                object(key).discord(receipt),
              ),
              Effect.map(HttpServerResponse.jsonUnsafe),
            ),
          )
          .handleRaw("control", ({ request }) =>
            input(
              request,
              Schema.Struct({ key: Schema.String, control: Control }),
            ).pipe(
              Effect.flatMap(({ key, control }) =>
                object(key).control(control),
              ),
              Effect.as(HttpServerResponse.empty({ status: 204 })),
            ),
          )
          .handleRaw("recover", ({ request }) =>
            input(request, Schema.Struct({ key: Schema.String })).pipe(
              Effect.flatMap(({ key }) => object(key).recover()),
              Effect.as(HttpServerResponse.empty({ status: 204 })),
            ),
          )
          .handleRaw("reconstruct", ({ request }) =>
            input(request, Schema.Struct({ key: Schema.String })).pipe(
              Effect.flatMap(({ key }) =>
                acknowledgeReconstruction(
                  object(key).reconstruct(),
                  "tenant reconstruction fixture",
                ),
              ),
            ),
          ),
    );

    return {
      fetch: HttpApiBuilder.layer(TenantFixtureApi).pipe(
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

export default TenantFixtureWorker;
