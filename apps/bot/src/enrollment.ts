import {
  AccountError,
  EnrollmentNonce,
  EnrollmentSession,
  type TwitchEnrollment,
} from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import { Effect, Schema } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/http";

export const enrollmentCookie = "__Host-arctools-enrollment";

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const BrowserSession = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const CallbackCode = Schema.NonEmptyString.check(Schema.isMaxLength(2048));

const randomCredential = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const readSession = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const cookie = request.headers.cookie ?? "";

  if (cookie.length > 4096) return yield* new AccountError({ code: "input" });

  const values = cookie
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.split("=", 1)[0] === enrollmentCookie);

  if (values.length === 0) return null;

  if (values.length !== 1) return yield* new AccountError({ code: "input" });
  const value = values[0]?.slice(enrollmentCookie.length + 1);

  const valid = yield* Schema.decodeUnknownEffect(BrowserSession)(value).pipe(
    Effect.mapError(() => new AccountError({ code: "input" })),
  );

  return yield* Schema.decodeUnknownEffect(EnrollmentSession)(
    yield* digest(valid),
  ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));
});

const requiredSession = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const session = yield* readSession(request);

  if (!session) return yield* new AccountError({ code: "state" });

  return session;
});

export const enrollmentHttp = (account: typeof TwitchEnrollment.Service) => ({
  begin: (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (request.url.length > 4096)
        return yield* new AccountError({ code: "input" });
      const previousSession = yield* readSession(request);
      const credential = randomCredential();
      const state = `enroll.${randomCredential()}`;
      const session = EnrollmentSession.make(yield* digest(credential));

      const location = yield* account.begin({
        session,
        previousSession,
        state,
      });

      return HttpServerResponse.empty({
        status: 302,
        headers: {
          ...headers,
          Location: location,
          "Set-Cookie": `${enrollmentCookie}=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
        },
      });
    }).pipe(
      Effect.timeout(12_000),
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "enrollment-unavailable" },
            { status: 503, headers },
          ),
        ),
      ),
    ),
  status: (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (request.url.length > 4096)
        return yield* new AccountError({ code: "input" });
      const status = yield* account.status(yield* requiredSession(request));

      return HttpServerResponse.jsonUnsafe(status, { headers });
    }).pipe(
      Effect.timeout(12_000),
      Effect.catchTag("AccountError", (error) =>
        error.code === "state" || error.code === "input"
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "enrollment-unavailable" },
                { status: 401, headers },
              ),
            )
          : error,
      ),
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "enrollment-unavailable" },
            { status: 503, headers },
          ),
        ),
      ),
    ),
  complete: (request: HttpServerRequest.HttpServerRequest, url: URL) =>
    Effect.gen(function* () {
      const session = yield* requiredSession(request);

      if (
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("error").length > 1
      )
        return yield* new AccountError({ code: "input" });

      const state = yield* Schema.decodeUnknownEffect(EnrollmentNonce)(
        url.searchParams.get("state"),
      ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (
        error !== null &&
        (error.length === 0 || error.length > 128 || code !== null)
      )
        return yield* new AccountError({ code: "input" });

      const outcome =
        error !== null
          ? ({ kind: "denied" } satisfies Parameters<
              typeof account.complete
            >[0]["outcome"])
          : ({
              kind: "accepted",
              code: yield* Schema.decodeUnknownEffect(CallbackCode)(code).pipe(
                Effect.mapError(() => new AccountError({ code: "input" })),
              ),
            } satisfies Parameters<typeof account.complete>[0]["outcome"]);

      yield* account.complete({ session, state, outcome });

      return HttpServerResponse.empty({
        status: 303,
        headers: { ...headers, Location: "/connect" },
      });
    }),
});
