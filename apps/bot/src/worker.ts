import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { BotApi } from "./api.js";
import { bindOrigin, buildRevision, runtimeConfig } from "./config.js";
import { manifestHash } from "./discord-manifest.js";
import { ingressHandlers } from "./ingress.js";
import { operatorHandlers } from "./operator.js";
import { bindTenants } from "./tenant.js";
import { Tenants } from "./tenant-contracts.js";
import { bindAccount } from "./twitch.js";
import { TwitchAccount } from "./twitch-contracts.js";

export class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
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
    const origin = yield* bindOrigin;
    const bindings =
      identity.kind === "test" && identity.stage.startsWith("test-tenant-")
        ? yield* Effect.promise(
            () => import("../../../tests/cloud/bot-composition.js"),
          ).pipe(
            Effect.flatMap(({ botTestBindings }) => botTestBindings(identity)),
          )
        : Layer.empty;
    const revision = yield* buildRevision;
    const hash = yield* manifestHash;
    const client = yield* bindAccount.pipe(Effect.provide(bindings));
    const tenantClient = yield* bindTenants.pipe(Effect.provide(bindings));
    return {
      fetch: Effect.gen(function* () {
        const receivedAt = Date.now();
        const account = yield* client;
        const tenants = yield* tenantClient;
        const callback = `${yield* origin}/webhooks/twitch`;
        const handler = yield* HttpApiBuilder.layer(BotApi).pipe(
          Layer.provide(
            HttpApiBuilder.group(BotApi, "health", (handlers) =>
              handlers.handle("health", () =>
                Effect.succeed({
                  status: "foundation",
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
        return yield* handler.pipe(
          Effect.map((response) =>
            HttpServerResponse.setHeader(
              response,
              "x-arc-ingress-ms",
              String(Date.now() - receivedAt),
            ),
          ),
        );
      }),
    };
  }),
) {}

export default Bot;
