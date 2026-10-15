import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

export class BotApi extends HttpApi.make("arc-tools").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Struct({
        status: Schema.Literal("foundation"),
        stage: Schema.String,
      }),
    }),
  ),
) {}
