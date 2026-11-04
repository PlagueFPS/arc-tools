import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { operatorErrors } from "./operator-errors.js";

export class BotApi extends HttpApi.make("arc-tools").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Struct({
        status: Schema.Literal("ready"),
        stage: Schema.String,
        revision: Schema.String,
        manifestHash: Schema.String,
      }),
    }),
  ),
  HttpApiGroup.make("ingress").add(
    HttpApiEndpoint.post("twitch", "/webhooks/twitch"),
    HttpApiEndpoint.post("discord", "/interactions/discord"),
  ),
  HttpApiGroup.make("operator").add(
    HttpApiEndpoint.post("setup", "/ops/setup", { error: operatorErrors }),
    HttpApiEndpoint.post("status", "/ops/status", { error: operatorErrors }),
  ),
) {}
