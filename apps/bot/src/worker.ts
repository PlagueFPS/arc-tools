import * as Cloudflare from "@alchemy.run/cloudflare";
import { ArcCacheDO } from "@arctools/arc-data/cloudflare";
import type { BotOperations } from "@arctools/bot-contracts";
import { manifestHash } from "@arctools/discord/server";
import { TwitchAccount } from "@arctools/twitch/server";
import { Stack } from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Effect,
  Layer,
  String as EffectString,
  Clock as EffectClock,
} from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { BotApi } from "./api.js";
import { bindBotOrigin, buildRevision, runtimeConfig } from "./config.js";
import { ingressHandlers } from "./ingress.js";
import { operatorHandlers } from "./operator.js";
import { botOperations } from "./rpc.js";
import { Tenants } from "./tenant-contracts.js";
import { TenantBoundaryObserver } from "./tenant-diagnostics.js";
import { bindTenants } from "./tenant.js";
import { bindAccount, bindEnrollment } from "./twitch.js";

type BotEntrypoint = BotOperations<RuntimeContext> & {
  readonly fetch: HttpEffect<RuntimeContext | Cloudflare.WorkerServices>;
};

export class Bot extends Cloudflare.Worker<Bot, BotEntrypoint>()("Bot") {}

export default Bot.make(
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-bot-${stage}`,
      main: import.meta.url,
      workersDev: true,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: false },
      },
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const config = yield* runtimeConfig;
    const { identity, operatorSecret } = config;
    const origin = yield* bindBotOrigin;

    const testComposition =
      identity.kind === "test" &&
      EffectString.startsWith("test-tenant-")(identity.stage)
        ? yield* Effect.promise(
            () => import("../../../tests/cloud/bot-composition.js"),
          )
        : null;

    const bindings = testComposition
      ? yield* testComposition.botTestBindings(identity)
      : Layer.empty;

    const revision = yield* buildRevision;
    const hash = yield* manifestHash;
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
    yield* ArcCacheDO.pipe(Effect.provide(bindings));
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
    const client = yield* bindAccount.pipe(Effect.provide(bindings));

    const enrollmentClient = yield* bindEnrollment.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
      Effect.provide(bindings),
    );

    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
    const tenantClient = yield* bindTenants.pipe(Effect.provide(bindings));

    return {
      ...botOperations({
        account: client,
        enrollment: enrollmentClient,
        operatorSecret,
      }),
      fetch: Effect.gen(function* () {
        const receivedAt = yield* EffectClock.currentTimeMillis;
        const observation = testComposition?.botRequestObservation(identity);

        const response = yield* Effect.gen(function* () {
          const account = yield* client;

          const tenants = yield* observation
            ? tenantClient.pipe(
                Effect.provideService(
                  TenantBoundaryObserver,
                  observation.observer,
                ),
              )
            : tenantClient;

          const callback = `${yield* origin}/webhooks/twitch`;

          const handler = yield* HttpApiBuilder.layer(BotApi).pipe(
            Layer.provide(
              HttpApiBuilder.group(BotApi, "health", (handlers) =>
                handlers.handle("health", () =>
                  Effect.succeed({
                    status: "ready",
                    stage: identity.stage,
                    revision,
                    manifestHash: hash,
                  }),
                ),
              ),
            ),
            Layer.provide(
              operatorHandlers(identity.stage, operatorSecret).pipe(
                Layer.provide(Layer.succeed(TwitchAccount, account)),
              ),
            ),
            Layer.provide(
              ingressHandlers({ ...config, callback, receivedAt }).pipe(
                Layer.provide(Layer.succeed(TwitchAccount, account)),
                Layer.provide(Layer.succeed(Tenants, tenants)),
              ),
            ),
            Layer.provide(HttpRouter.disableLogger),
            Layer.provide(
              Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true),
            ),
            Layer.provide(HttpServer.layerServices),
            HttpRouter.toHttpEffect,
          );

          return yield* handler;
        });

        return yield* Effect.succeed(response).pipe(
          Effect.map((response) =>
            observation
              ? HttpServerResponse.setHeaders(response, observation.headers())
              : response,
          ),
          Effect.map((response) =>
            HttpServerResponse.setHeader(
              response,
              "x-arc-ingress-ms",
              // oxlint-disable-next-line effecttsgo/global-date -- Ingress duration compares host wall time with the original host receipt timestamp.
              String(Date.now() - receivedAt),
            ),
          ),
        );
      }),
    };
  }),
);
