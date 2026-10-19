import { Effect, Redacted, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { BotApi } from "./api.js";
import { Stage } from "./config.js";
import { digest } from "./provider-http.js";
import { TwitchAccount } from "./twitch-contracts.js";

export const OperatorRequest = Schema.Struct({ stage: Stage });
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const response = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });
const body = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  let length = 0;
  let text = "";
  const decoder = new TextDecoder();
  yield* request.stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        length += chunk.byteLength;
        if (length > 4096) throw new Error("bounded operator body");
        text += decoder.decode(chunk, { stream: true });
      }),
    ),
  );
  text += decoder.decode();
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(OperatorRequest),
  )(text);
});
export const operatorHandlers = (
  stage: string,
  secret: Redacted.Redacted<string>,
) =>
  HttpApiBuilder.group(BotApi, "operator", (handlers) =>
    Effect.gen(function* () {
      const account = yield* TwitchAccount;
      const authorized = Effect.fnUntraced(function* (
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const supplied = request.headers.authorization;
        if (!supplied || supplied.length > 1024) return false;
        const actual = yield* digest(supplied);
        const expected = yield* digest(`Bearer ${Redacted.value(secret)}`);
        return actual === expected;
      });
      const handle = (
        operation: "setup" | "status",
        request: HttpServerRequest.HttpServerRequest,
      ) =>
        Effect.gen(function* () {
          if (!(yield* authorized(request)))
            return response({ error: "unauthorized" }, 401);
          const input = yield* body(request);
          if (input.stage !== stage)
            return response({ error: "stage-mismatch" }, 409);
          const result =
            operation === "setup"
              ? yield* account.setup(yield* digest(Redacted.value(secret)))
              : yield* account.status();
          return response(result);
        }).pipe(
          Effect.timeout(25_000),
          Effect.catchCause(() =>
            Effect.succeed(
              response({ error: "operator-operation-failed" }, 503),
            ),
          ),
        );
      return handlers
        .handleRaw("setup", ({ request }) => handle("setup", request))
        .handleRaw("status", ({ request }) => handle("status", request))
        .handleRaw("oauth", ({ request }) =>
          Effect.gen(function* () {
            if (request.url.length > 4096)
              return response({ error: "invalid-callback" }, 400);
            const url = new URL(request.url, "https://callback.invalid");
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                state: Schema.NonEmptyString,
                code: Schema.NonEmptyString,
              }),
            )({
              state: url.searchParams.get("state"),
              code: url.searchParams.get("code"),
            });
            yield* account.completeOAuth({
              ...input,
              operator: yield* digest(Redacted.value(secret)),
            });
            return HttpServerResponse.text(
              "<!doctype html><meta name=referrer content=no-referrer><title>ARC Tools authorization</title><p>Authorization recorded. Run setup again in the CLI.</p>",
              { headers, contentType: "text/html" },
            );
          }).pipe(
            Effect.timeout(12_000),
            Effect.catchCause(() =>
              Effect.succeed(response({ error: "authorization-failed" }, 400)),
            ),
          ),
        );
    }),
  );
