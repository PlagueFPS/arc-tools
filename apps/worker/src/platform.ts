import { commands } from "@arctools/commands";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/http";
import { type BotWork, ERROR_TEXT, type ReplyTarget } from "./domain.ts";

export class HttpFailure extends Schema.TaggedError<HttpFailure>()(
  "HttpFailure",
  {
    retryable: Schema.Boolean,
    status: Schema.Number,
    retryAfter: Schema.Number,
    cause: Schema.Unknown,
  },
) {}

export function retryAfter(value: string | null, now = Date.now()): number {
  if (value === null) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10 * 60_000)) : 0;
}

export const requestJson = Effect.fnUntraced(function* (
  url: string,
  init: RequestInit,
) {
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) {
        const now = Date.now();
        const resetAt = Number(response.headers.get("ratelimit-reset")) * 1000;
        const resetDelay =
          response.status === 429 && Number.isFinite(resetAt)
            ? Math.max(0, Math.min(resetAt - now, 10 * 60_000))
            : 0;
        return {
          status: response.status,
          retryAfter: Math.max(
            retryAfter(response.headers.get("retry-after"), now),
            resetDelay,
          ),
          body: undefined,
        };
      }
      const text = await response.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      return { status: response.status, retryAfter: 0, body };
    },
    catch: (cause) =>
      new HttpFailure({
        retryable: !(cause instanceof SyntaxError),
        status: 0,
        retryAfter: 0,
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        new HttpFailure({
          retryable: true,
          status: 0,
          retryAfter: 0,
          cause: "HTTP timeout",
        }),
    }),
  );
  if (result.status < 200 || result.status >= 300) {
    return yield* new HttpFailure({
      status: result.status,
      retryable: result.status === 429 || result.status >= 500,
      retryAfter: result.retryAfter,
      cause: "HTTP status",
    });
  }
  return result.body;
});

export const renderCommand = Effect.fnUntraced(function* (work: BotWork) {
  const command = commands.find((command) => command.name === work.command);
  if (command === undefined) return ERROR_TEXT;
  return yield* command.handler(work.input).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        new HttpFailure({
          status: 0,
          retryable: true,
          retryAfter: 0,
          cause: "Command timeout",
        }),
    }),
    Effect.catchTag("CommandError", (error) => {
      const cause = error.cause;
      if (HttpClientError.isHttpClientError(cause)) {
        const retryable =
          cause.reason._tag === "TransportError" ||
          cause.response?.status === 429 ||
          (cause.response?.status ?? 0) >= 500;
        if (retryable)
          return new HttpFailure({
            status: cause.response?.status ?? 0,
            retryable: true,
            retryAfter: retryAfter(
              cause.response?.headers["retry-after"] ?? null,
            ),
            cause: "Command upstream unavailable",
          });
      }
      return Effect.succeed(error.message);
    }),
  );
});

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  token_type: Schema.String.check(Schema.isPattern(/^bearer$/i)),
});
const SendResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      message_id: Schema.String,
      is_sent: Schema.Boolean,
      drop_reason: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ code: Schema.String, message: Schema.String }),
        ),
      ),
    }),
  ).check(Schema.isBetweenLength(1, 1)),
});
export const makeTwitchSender = (credentials: {
  clientId: string;
  clientSecret: string;
  botId: string;
}) => {
  let cached: { token: string; expiresAt: number } | undefined;
  const appToken = Effect.fnUntraced(function* () {
    if (cached !== undefined && cached.expiresAt > Date.now())
      return cached.token;
    const body = yield* requestJson("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });
    const result = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
      Effect.mapError(
        (cause) =>
          new HttpFailure({
            status: 0,
            retryable: false,
            retryAfter: 0,
            cause,
          }),
      ),
    );
    cached = {
      token: result.access_token,
      expiresAt: Date.now() + Math.max(0, result.expires_in * 1000 - 60000),
    };
    return cached.token;
  });
  return Effect.fnUntraced(function* (
    target: Extract<ReplyTarget, { kind: "twitch" }>,
    text: string,
  ) {
    const send = Effect.fnUntraced(function* () {
      const token = yield* appToken();
      return yield* requestJson("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        headers: {
          "client-id": credentials.clientId,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          broadcaster_id: target.broadcasterId,
          sender_id: credentials.botId,
          reply_parent_message_id: target.messageId,
          message: Array.from(text).slice(0, 500).join(""),
        }),
      });
    });
    const body = yield* send().pipe(
      Effect.catchTag(
        "HttpFailure",
        Effect.fnUntraced(function* (error) {
          if (error.status !== 401) return yield* error;
          cached = undefined;
          return yield* send();
        }),
      ),
    );
    const result = yield* Schema.decodeUnknownEffect(SendResponse)(body).pipe(
      Effect.mapError(
        (cause) =>
          new HttpFailure({
            status: 0,
            retryable: false,
            retryAfter: 0,
            cause,
          }),
      ),
    );
    for (const message of result.data) {
      if (!message.is_sent || message.drop_reason != null)
        return yield* new HttpFailure({
          status: 200,
          retryable: false,
          retryAfter: 0,
          cause: "Twitch dropped the reply",
        });
    }
  });
};

export const editDiscord = Effect.fnUntraced(function* (
  target: Extract<ReplyTarget, { kind: "discord" }>,
  text: string,
) {
  yield* requestJson(
    `https://discord.com/api/v10/webhooks/${target.applicationId}/${encodeURIComponent(target.token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: Array.from(text).slice(0, 2000).join(""),
        allowed_mentions: { parse: [] },
      }),
    },
  ).pipe(
    Effect.catchTag("HttpFailure", (error) =>
      error.status === 404
        ? new HttpFailure({ ...error, retryable: true, retryAfter: 1000 })
        : error,
    ),
  );
});
