import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { BotApi } from "./api.js";
import { buildRevision, runtimeConfig } from "./config.js";
import { manifestHash } from "./discord-manifest.js";
import { operatorHandlers } from "./operator.js";
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
    const { identity, operatorSecret } = yield* runtimeConfig;
    const revision = yield* buildRevision;
    const hash = yield* manifestHash;
    const client = yield* bindAccount;
    return {
      fetch: Effect.gen(function* () {
        const account = yield* client;
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
          Layer.provide(HttpRouter.disableLogger),
          Layer.provide(
            Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true),
          ),
          Layer.provide(HttpServer.layerServices),
          HttpRouter.toHttpEffect,
        );
        return yield* handler;
      }),
    };
  }),
) {}

export default Bot;
