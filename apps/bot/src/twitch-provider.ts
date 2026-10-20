import {
  Layer,
  Predicate,
  Clock,
  Context,
  Effect,
  Redacted,
  Schema,
} from "effect";

import { decodeBody, type ProviderError, request } from "./provider-http.js";
import { subscriptionBinding } from "./twitch-binding.js";
import { AccountError, bounded, type Dispatch } from "./twitch-contracts.js";

const seconds = Schema.Int.check(Schema.isGreaterThan(0));

const Token = Schema.Struct({
  access_token: bounded(4096),
  expires_in: seconds,
  token_type: Schema.Literal("bearer"),
});

const Validation = Schema.Struct({
  client_id: bounded(128),
  expires_in: Schema.Int,
  user_id: Schema.optional(bounded(64)),
  login: Schema.optional(bounded(25)),
  scopes: Schema.NullOr(Schema.Array(bounded(128))),
});

const Users = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: bounded(64), login: bounded(25) })),
});

export const Subscription = Schema.Struct({
  id: bounded(128),
  status: bounded(128),
  type: bounded(128),
  version: bounded(16),
  condition: Schema.Record(Schema.String, Schema.String),
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.optional(Schema.String),
  }),
});

export type Subscription = typeof Subscription.Type;

const Page = Schema.Struct({
  data: Schema.Array(Subscription),
  pagination: Schema.optional(
    Schema.Struct({ cursor: Schema.optional(bounded(2048)) }),
  ),
});

const Creation = Schema.Struct({
  data: Schema.Tuple([Subscription]),
});

const CreateOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("created"),
    subscription: Schema.Struct({
      id: bounded(128),
      broadcasterId: bounded(64),
      senderId: bounded(64),
      callback: Schema.String,
      binding: Schema.String,
      status: Schema.Literals([
        "enabled",
        "webhook_callback_verification_pending",
      ]),
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);

const Sent = Schema.Struct({
  data: Schema.Tuple([
    Schema.Struct({
      is_sent: Schema.Boolean,
      message_id: Schema.String,
      drop_reason: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ code: bounded(128), message: Schema.String }),
        ),
      ),
    }),
  ]),
});

export type SendResult = (
  | { readonly kind: "sent"; readonly messageId: string }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "limited"; readonly retryAt: number }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "expired" }
) & { readonly blockedUntil?: number };

export interface Provider {
  readonly mint: () => Effect.Effect<typeof Token.Type, AccountError>;
  readonly validate: (
    token: string,
  ) => Effect.Effect<typeof Validation.Type, AccountError>;
  readonly exchange: (
    code: string,
  ) => Effect.Effect<typeof Token.Type, AccountError>;
  readonly users: (
    token: string,
    logins: readonly string[],
  ) => Effect.Effect<(typeof Users.Type)["data"], AccountError>;
  readonly list: (
    token: string,
  ) => Effect.Effect<readonly Subscription[], AccountError>;
  readonly create: (
    token: string,
    channel: string,
    sender: string,
  ) => Effect.Effect<typeof CreateOutcome.Type, AccountError>;
  readonly remove: (
    token: string,
    id: string,
  ) => Effect.Effect<void, AccountError>;
  readonly send: (
    token: string,
    sender: string,
    input: Dispatch,
  ) => Effect.Effect<SendResult>;
}

export class TwitchProvider extends Context.Service<TwitchProvider, Provider>()(
  "@arctools/TwitchProvider",
) {}

export interface ProviderConfig {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly signingSecret: Redacted.Redacted<string>;
  readonly callback: string;
  readonly redirect: string;
}

export const makeProvider = (
  config: ProviderConfig,
  endpoints = {
    api: "https://api.twitch.tv/helix",
    oauth: "https://id.twitch.tv/oauth2",
  },
): Provider => {
  const headers = (token: string) => ({
    "Client-Id": config.clientId,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  const checked = Effect.fnUntraced(function* (
    path: string,
    token: string,
    init: RequestInit = {},
  ) {
    const result = yield* request(`${endpoints.api}${path}`, {
      ...init,
      headers: headers(token),
    });

    if (result.status === 401)
      return yield* new AccountError({ code: "client" });

    if (result.status < 200 || result.status >= 300)
      return yield* new AccountError({ code: "provider" });

    return result;
  });

  const token = Effect.fnUntraced(
    function* (params: Record<string, string>) {
      const result = yield* request(`${endpoints.oauth}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...params,
          client_id: config.clientId,
          client_secret: Redacted.value(config.clientSecret),
        }),
      });

      if (result.status !== 200)
        return yield* new AccountError({ code: "provider" });

      return yield* decodeBody(Token)(result.body);
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "AccountError")
            ? error
            : new AccountError({ code: "provider" }),
        ),
      ),
  );

  return TwitchProvider.of({
    mint: () => token({ grant_type: "client_credentials" }),
    exchange: (code) =>
      token({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirect,
      }),
    validate: Effect.fnUntraced(
      function* (token: string) {
        const result = yield* request(`${endpoints.oauth}/validate`, {
          headers: { Authorization: `OAuth ${token}` },
        });

        if (result.status === 401)
          return yield* new AccountError({ code: "client" });

        if (result.status !== 200)
          return yield* new AccountError({ code: "provider" });

        return yield* decodeBody(Validation)(result.body);
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "AccountError")
              ? error
              : new AccountError({ code: "provider" }),
          ),
        ),
    ),
    users: Effect.fnUntraced(
      function* (token: string, logins: readonly string[]) {
        const params = new URLSearchParams(
          logins.map((login) => ["login", login]),
        );

        return (yield* decodeBody(Users)(
          (yield* checked(`/users?${params}`, token)).body,
        )).data;
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "AccountError")
              ? error
              : new AccountError({ code: "provider" }),
          ),
        ),
    ),
    list: Effect.fnUntraced(
      function* (token: string) {
        const subscriptions: Subscription[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;

        do {
          const page = yield* decodeBody(Page)(
            (yield* checked(
              `/eventsub/subscriptions${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
              token,
            )).body,
          );

          subscriptions.push(...page.data);
          cursor = page.pagination?.cursor;

          if (
            subscriptions.length > 512 ||
            seen.size >= 64 ||
            (cursor && seen.has(cursor))
          )
            return yield* new AccountError({ code: "capacity" });

          if (cursor) seen.add(cursor);
        } while (cursor);

        return subscriptions;
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "AccountError")
              ? error
              : new AccountError({ code: "provider" }),
          ),
        ),
    ),
    create: Effect.fnUntraced(
      function* (token: string, channel: string, sender: string) {
        const result = yield* request(
          `${endpoints.api}/eventsub/subscriptions`,
          {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({
              type: "channel.chat.message",
              version: "1",
              condition: { broadcaster_user_id: channel, user_id: sender },
              transport: {
                method: "webhook",
                callback: config.callback,
                secret: Redacted.value(config.signingSecret),
              },
            }),
          },
        );

        if (result.status === 401)
          return yield* new AccountError({ code: "client" });

        if (result.status === 409)
          return { kind: "conflict" } satisfies typeof CreateOutcome.Type;

        if (result.status !== 202)
          return { kind: "unknown" } satisfies typeof CreateOutcome.Type;

        const {
          data: [subscription],
        } = yield* decodeBody(Creation)(result.body);

        if (
          subscription.type !== "channel.chat.message" ||
          subscription.version !== "1" ||
          subscription.transport.method !== "webhook" ||
          subscription.transport.callback !== config.callback ||
          subscription.condition.broadcaster_user_id !== channel ||
          subscription.condition.user_id !== sender ||
          (subscription.status !== "enabled" &&
            subscription.status !== "webhook_callback_verification_pending")
        )
          return { kind: "unknown" } satisfies typeof CreateOutcome.Type;

        return {
          kind: "created",
          subscription: {
            id: subscription.id,
            broadcasterId: channel,
            senderId: sender,
            callback: config.callback,
            binding: yield* subscriptionBinding(config),
            status: subscription.status,
          },
        } satisfies typeof CreateOutcome.Type;
      },
      (effect) =>
        effect.pipe(
          Effect.catchTags({
            AccountError: (error) =>
              error.code === "client"
                ? error
                : Effect.succeed<typeof CreateOutcome.Type>({
                    kind: "unknown",
                  }),
            ProviderError: () =>
              Effect.succeed<typeof CreateOutcome.Type>({ kind: "unknown" }),
          }),
        ),
    ),
    remove: Effect.fnUntraced(
      function* (token: string, id: string) {
        const result = yield* request(
          `${endpoints.api}/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
          { method: "DELETE", headers: headers(token) },
        );

        if (result.status !== 204 && result.status !== 404)
          return yield* new AccountError({
            code: result.status === 401 ? "client" : "provider",
          });
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "AccountError")
              ? error
              : new AccountError({ code: "provider" }),
          ),
        ),
    ),
    send: Effect.fnUntraced(
      function* (
        token: string,
        sender: string,
        input: Dispatch,
      ): Effect.fn.Return<SendResult, ProviderError> {
        const now = yield* Clock.currentTimeMillis;

        if (now >= input.deadline) return { kind: "expired" };

        const result = yield* request(
          `${endpoints.api}/chat/messages`,
          {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({
              broadcaster_id: input.broadcasterId,
              sender_id: sender,
              message: input.text,
              reply_parent_message_id: input.replyParentId,
              for_source_only: true,
            }),
          },
          Math.min(4_000, input.deadline - now),
        );

        const blockedUntil =
          result.headers.get("Ratelimit-Remaining") === "0"
            ? Number(result.headers.get("Ratelimit-Reset")) * 1000
            : 0;

        const budget =
          Number.isFinite(blockedUntil) && blockedUntil > now
            ? { blockedUntil }
            : {};

        if (result.status === 401) return { kind: "unauthorized", ...budget };

        if (result.status === 429) {
          const now = yield* Clock.currentTimeMillis;
          const reset = Number(result.headers.get("Ratelimit-Reset")) * 1000;

          return {
            kind: "limited",
            retryAt: Math.max(now + 1_000, Number.isFinite(reset) ? reset : 0),
          };
        }

        if ([400, 403, 422].includes(result.status))
          return { kind: "rejected", code: `http-${result.status}`, ...budget };

        if (result.status !== 200) return { kind: "ambiguous" };
        const decoded = yield* decodeBody(Sent)(result.body);
        const sent = decoded.data[0];

        if (!sent.is_sent)
          return {
            kind: "rejected",
            code: sent.drop_reason?.code ?? "dropped",
            ...budget,
          };

        if (!sent.message_id || sent.message_id.length > 128)
          return { kind: "ambiguous" };

        return { kind: "sent", messageId: sent.message_id, ...budget };
      },
      (effect) =>
        effect.pipe(
          Effect.catch(() => Effect.succeed<SendResult>({ kind: "ambiguous" })),
        ),
    ),
  });
};

export const providerLayer = (
  config: ProviderConfig,
  endpoints?: Parameters<typeof makeProvider>[1],
) => Layer.sync(TwitchProvider, () => makeProvider(config, endpoints));
