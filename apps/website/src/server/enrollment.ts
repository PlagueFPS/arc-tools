import {
  AccountError,
  EnrollmentNonce,
  EnrollmentSession,
  OAuthCompletion,
  enrollmentTiming,
} from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import { Effect, Schema, Struct } from "effect";

import type { BotOperations } from "../../../bot/src/rpc.js";
import type { WebsiteUnavailable } from "./errors.js";

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

const readSession = Effect.fnUntraced(function* (request: Request) {
  const cookie = request.headers.get("cookie") ?? "";

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

const requiredSession = Effect.fnUntraced(function* (request: Request) {
  const session = yield* readSession(request);

  if (!session) return yield* new AccountError({ code: "state" });

  return session;
});

export const websiteHttp = <R>(
  client: Effect.Effect<BotOperations, WebsiteUnavailable, R>,
) => {
  const handlers = {
    begin: Effect.fnUntraced(
      function* (request: Request) {
        if (request.url.length > 4096)
          return yield* new AccountError({ code: "input" });
        const previousSession = yield* readSession(request);
        const credential = randomCredential();
        const state = `enroll.${randomCredential()}`;
        const session = EnrollmentSession.make(yield* digest(credential));

        const location = yield* (yield* client).enrollmentBegin({
          session,
          previousSession,
          state,
        });

        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            Location: location,
            "Set-Cookie": `${enrollmentCookie}=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
          },
        });
      },
      (effect) =>
        effect.pipe(
          Effect.timeout(12_000),
          Effect.catchCause(() =>
            Effect.succeed(
              Response.json(
                { error: "enrollment-unavailable" },
                { status: 503, headers },
              ),
            ),
          ),
        ),
    ),
    status: Effect.fnUntraced(
      function* (request: Request) {
        if (request.url.length > 4096)
          return yield* new AccountError({ code: "input" });
        const session = yield* requiredSession(request);
        const status = yield* (yield* client).enrollmentStatus(session);

        return Response.json(status, { headers });
      },
      (effect) =>
        effect.pipe(
          Effect.timeout(12_000),
          Effect.catchTag("AccountError", (error) =>
            error.code === "state" || error.code === "input"
              ? Effect.succeed(
                  Response.json(
                    { error: "enrollment-unavailable" },
                    { status: 401, headers },
                  ),
                )
              : error,
          ),
          Effect.catchCause(() =>
            Effect.succeed(
              Response.json(
                { error: "enrollment-unavailable" },
                { status: 503, headers },
              ),
            ),
          ),
        ),
    ),
    completeEnrollment: Effect.fnUntraced(function* (
      request: Request,
      url: URL,
    ) {
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
              BotOperations["enrollmentComplete"]
            >[0]["outcome"])
          : ({
              kind: "accepted",
              code: yield* Schema.decodeUnknownEffect(CallbackCode)(code).pipe(
                Effect.mapError(() => new AccountError({ code: "input" })),
              ),
            } satisfies Parameters<
              BotOperations["enrollmentComplete"]
            >[0]["outcome"]);

      yield* (yield* client).enrollmentComplete({ session, state, outcome });

      return new Response(null, {
        status: 303,
        headers: { ...headers, Location: "/connect" },
      });
    }),
  };

  return {
    ...handlers,
    callback: Effect.fnUntraced(
      function* (request: Request) {
        if (request.url.length > 4096)
          return Response.json(
            { error: "invalid-callback" },
            { status: 400, headers },
          );
        const url = new URL(request.url);

        if (url.searchParams.getAll("state").length !== 1)
          return Response.json(
            { error: "invalid-callback" },
            { status: 400, headers },
          );

        if (url.searchParams.get("state")?.startsWith("enroll."))
          return yield* handlers
            .completeEnrollment(request, url)
            .pipe(Effect.timeout(enrollmentTiming.callbackMs));

        if (url.searchParams.getAll("code").length !== 1)
          return Response.json(
            { error: "invalid-callback" },
            { status: 400, headers },
          );

        const input = yield* Schema.decodeUnknownEffect(
          OAuthCompletion.mapFields(Struct.omit(["operator"])),
        )({
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
        });

        yield* (yield* client)
          .completeOperatorOAuth(input)
          .pipe(Effect.timeout(12_000));

        return new Response(
          "<!doctype html><meta name=referrer content=no-referrer><title>ARC Tools authorization</title><p>Authorization recorded. Run setup again in the CLI.</p>",
          { headers: { ...headers, "Content-Type": "text/html" } },
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catchTag("WebsiteUnavailable", () =>
            Effect.succeed(
              Response.json(
                { error: "enrollment-unavailable" },
                { status: 503, headers },
              ),
            ),
          ),
          Effect.catchCause(() =>
            Effect.succeed(
              Response.json(
                { error: "authorization-failed" },
                { status: 400, headers },
              ),
            ),
          ),
        ),
    ),
  };
};

export const enrollmentHead = () =>
  new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
