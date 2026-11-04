import {
  AccountStatus,
  SetupResult,
  TwitchAccount,
} from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import { Effect, Match, Redacted, Schema, Stream } from "effect";
import {
  type HttpServerError,
  type HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { BotApi } from "./api.js";
import { Stage } from "./config.js";
import {
  OperatorUnauthorized,
  OperatorStageMismatch,
  OperatorInvalidRequest,
  OperatorBodyTooLarge,
  OperatorBusy,
  OperatorCapacityExceeded,
  OperatorOperationFailed,
} from "./operator-errors.js";

export { OperatorBodyTooLarge } from "./operator-errors.js";

export const OperatorRequest = Schema.Struct({ stage: Stage });

type OperatorBodyError = HttpServerError.HttpServerError | OperatorBodyTooLarge;

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const response = (body: AccountStatus | SetupResult) =>
  HttpServerResponse.jsonUnsafe(body, { headers });

const problem = (error: HttpServerRespondable.Respondable) =>
  HttpServerRespondable.toResponse(error).pipe(
    Effect.map(HttpServerResponse.setHeaders(headers)),
  );

export const readOperatorBody = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const bytes = yield* request.stream.pipe(
    Stream.limitBytes<OperatorBodyError, never>(4096, () =>
      Stream.fail(new OperatorBodyTooLarge()),
    ),
    Stream.mkUint8Array,
  );

  return yield* Schema.decodeEffect(Schema.fromJsonString(OperatorRequest))(
    new TextDecoder().decode(bytes),
  );
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
            return yield* problem(new OperatorUnauthorized());
          const input = yield* readOperatorBody(request);

          if (input.stage !== stage)
            return yield* problem(new OperatorStageMismatch());

          const result =
            operation === "setup"
              ? yield* account.setup(yield* digest(Redacted.value(secret)))
              : yield* account.status;

          return response(result);
        }).pipe(
          Effect.timeout(25_000),
          Effect.catchTags({
            OperatorBodyTooLarge: problem,
            SchemaError: () => problem(new OperatorInvalidRequest()),
            HttpServerError: () => problem(new OperatorInvalidRequest()),
          }),
          Effect.catchTag("AccountError", (error) =>
            Match.value(error.code).pipe(
              Match.when("busy", () =>
                problem(new OperatorBusy()).pipe(
                  Effect.map(HttpServerResponse.setHeader("Retry-After", "1")),
                ),
              ),
              Match.when("capacity", () =>
                problem(new OperatorCapacityExceeded()),
              ),
              Match.orElse(() => error),
            ),
          ),
          Effect.catchCause(() => problem(new OperatorOperationFailed())),
        );

      return handlers
        .handleRaw("setup", ({ request }) => handle("setup", request))
        .handleRaw("status", ({ request }) => handle("status", request));
    }),
  );
