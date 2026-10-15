import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { BotApi } from "./api.js";
import { runtimeConfig } from "./config.js";

export class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      name: `arc-tools-bot-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const { identity } = yield* runtimeConfig;
    return {
      fetch: HttpApiBuilder.layer(BotApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(BotApi, "health", (handlers) =>
            handlers.handle("health", () =>
              Effect.succeed({ status: "foundation", stage: identity.stage }),
            ),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
      ),
    };
  }),
) {}

export default Bot;
