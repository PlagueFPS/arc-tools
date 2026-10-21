import {
  AccountStatus,
  enrollmentTiming,
  SetupResult,
  TwitchAccount,
  TwitchEnrollment,
} from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import { Effect, Redacted, Schema, Stream } from "effect";
import {
  type HttpServerError,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { BotApi } from "./api.js";
import { Stage } from "./config.js";
import { enrollmentHttp } from "./enrollment.js";

export const OperatorRequest = Schema.Struct({ stage: Stage });

export class OperatorBodyTooLarge extends Schema.TaggedError<OperatorBodyTooLarge>()(
  "OperatorBodyTooLarge",
  {},
) {}

type OperatorBodyError = HttpServerError.HttpServerError | OperatorBodyTooLarge;

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const response = (
  body:
    | typeof AccountStatus.Type
    | typeof SetupResult.Type
    | { readonly error: string },
  status = 200,
) => HttpServerResponse.jsonUnsafe(body, { status, headers });

export const readOperatorBody = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const bytes = yield* request.stream.pipe(
    Stream.limitBytes<OperatorBodyError, never>(4096, () =>
      Stream.fail(new OperatorBodyTooLarge()),
    ),
    Stream.mkUint8Array,
  );

  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(OperatorRequest),
  )(new TextDecoder().decode(bytes));
});

export const operatorHandlers = (
  stage: string,
  secret: Redacted.Redacted<string>,
) =>
  HttpApiBuilder.group(BotApi, "operator", (handlers) =>
    Effect.gen(function* () {
      const account = yield* TwitchAccount;
      const enrollment = enrollmentHttp(yield* TwitchEnrollment);

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
          const input = yield* readOperatorBody(request);

          if (input.stage !== stage)
            return response({ error: "stage-mismatch" }, 409);

          const result =
            operation === "setup"
              ? yield* account.setup(yield* digest(Redacted.value(secret)))
              : yield* account.status();

          return response(result);
        }).pipe(
          Effect.timeout(25_000),
          Effect.catchTag("AccountError", (error) =>
            error.code === "capacity"
              ? Effect.succeed(
                  response({ error: "channel-capacity-exceeded" }, 409),
                )
              : error,
          ),
          Effect.catchCause(() =>
            Effect.succeed(
              response({ error: "operator-operation-failed" }, 503),
            ),
          ),
        );

      return handlers
        .handleRaw("setup", ({ request }) => handle("setup", request))
        .handleRaw("status", ({ request }) => handle("status", request))
        .handleRaw("enroll", ({ request }) => enrollment.begin(request))
        .handleRaw("enrollmentStatus", ({ request }) =>
          enrollment.status(request),
        )
        .handleRaw("oauth", ({ request }) =>
          Effect.gen(function* () {
            if (request.url.length > 4096)
              return response({ error: "invalid-callback" }, 400);
            const url = new URL(request.url, "https://callback.invalid");

            if (url.searchParams.getAll("state").length !== 1)
              return response({ error: "invalid-callback" }, 400);

            if (url.searchParams.get("state")?.startsWith("enroll."))
              return yield* enrollment
                .complete(request, url)
                .pipe(Effect.timeout(enrollmentTiming.callbackMs));

            if (url.searchParams.getAll("code").length !== 1)
              return response({ error: "invalid-callback" }, 400);

            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                state: Schema.NonEmptyString,
                code: Schema.NonEmptyString,
              }),
            )({
              state: url.searchParams.get("state"),
              code: url.searchParams.get("code"),
            });

            yield* account
              .completeOAuth({
                ...input,
                operator: yield* digest(Redacted.value(secret)),
              })
              .pipe(Effect.timeout(12_000));

            return HttpServerResponse.text(
              "<!doctype html><meta name=referrer content=no-referrer><title>ARC Tools authorization</title><p>Authorization recorded. Run setup again in the CLI.</p>",
              { headers, contentType: "text/html" },
            );
          }).pipe(
            Effect.catchCause(() =>
              Effect.succeed(response({ error: "authorization-failed" }, 400)),
            ),
          ),
        );
    }),
  );
