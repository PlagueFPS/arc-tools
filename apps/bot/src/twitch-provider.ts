import {
  Layer,
  Predicate,
  Clock,
  Context,
  Effect,
  Redacted,
  Schema,
  SchemaGetter,
  Option,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  decodeBody,
  type ProviderError,
  readJson,
  request,
} from "./provider-http.js";
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

const ResetTimestamp = Schema.Finite.pipe(Schema.brand("RateLimitResetMillis"));

const RateLimitHeaders = Schema.Struct({
  "ratelimit-remaining": Schema.optional(Schema.String),
  "ratelimit-reset": Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ exhausted: Schema.Boolean, reset: ResetTimestamp }),
    {
      decode: SchemaGetter.transform((headers) => ({
        exhausted: headers["ratelimit-remaining"] === "0",
        reset: Number(headers["ratelimit-reset"]) * 1000,
      })),
      encode: SchemaGetter.forbidden(() => "Response headers are decode only"),
    },
  ),
  Schema.catchDecoding(() =>
    Effect.succeed(
      Option.some({ exhausted: false, reset: ResetTimestamp.make(0) }),
    ),
  ),
);

const readAcceptedJson = HttpClientResponse.matchStatus({
  "2xx": readJson,
  429: readJson,
  orElse: () => Effect.succeed(null),
});

export const makeProvider = Effect.fnUntraced(function* (
  config: ProviderConfig,
  endpoints = {
    api: "https://api.twitch.tv/helix",
    oauth: "https://id.twitch.tv/oauth2",
  },
) {
  const transport = yield* HttpClient.HttpClient;

  const helix = transport.pipe(
    HttpClient.mapRequest((outgoing) =>
      outgoing.pipe(
        HttpClientRequest.prependUrl(endpoints.api),
        HttpClientRequest.setHeader("Client-Id", config.clientId),
      ),
    ),
  );

  const oauth = transport.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(endpoints.oauth)),
  );

  const authenticated = (
    client: HttpClient.HttpClient,
    token: string,
    scheme: "Bearer" | "OAuth",
  ) =>
    client.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("Authorization", `${scheme} ${token}`),
      ),
    );

  const checked = Effect.fnUntraced(function* (
    outgoing: HttpClientRequest.HttpClientRequest,
    token: string,
  ) {
    return yield* request<unknown, AccountError | ProviderError, never>(
      authenticated(helix, token, "Bearer"),
      outgoing,
      Effect.fnUntraced(function* (response) {
        const body = yield* readAcceptedJson(response);

        return yield* HttpClientResponse.matchStatus(response, {
          401: () => new AccountError({ code: "client" }),
          "2xx": () => Effect.succeed(body),
          orElse: () => new AccountError({ code: "provider" }),
        });
      }),
    );
  });

  const accountError = (error: AccountError | ProviderError) =>
    Predicate.isTagged(error, "AccountError")
      ? error
      : new AccountError({ code: "provider" });

  const token = Effect.fnUntraced(
    function* (params: Record<string, string>) {
      return yield* request(
        oauth,
        HttpClientRequest.post("/token").pipe(
          HttpClientRequest.bodyUrlParams({
            ...params,
            client_id: config.clientId,
            client_secret: Redacted.value(config.clientSecret),
          }),
        ),
        Effect.fnUntraced(function* (response) {
          const body = yield* readAcceptedJson(response);

          return yield* HttpClientResponse.matchStatus(response, {
            200: () => decodeBody(Token)(body),
            orElse: () => new AccountError({ code: "provider" }),
          });
        }),
      );
    },
    (effect) => effect.pipe(Effect.mapError(accountError)),
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
        return yield* request<
          typeof Validation.Type,
          AccountError | ProviderError,
          never
        >(
          authenticated(oauth, token, "OAuth"),
          HttpClientRequest.get("/validate"),
          Effect.fnUntraced(function* (response) {
            const body = yield* readAcceptedJson(response);

            return yield* HttpClientResponse.matchStatus(response, {
              200: () => decodeBody(Validation)(body),
              401: () => new AccountError({ code: "client" }),
              orElse: () => new AccountError({ code: "provider" }),
            });
          }),
        );
      },
      (effect) => effect.pipe(Effect.mapError(accountError)),
    ),
    users: Effect.fnUntraced(
      function* (token: string, logins: readonly string[]) {
        return (yield* decodeBody(Users)(
          yield* checked(
            HttpClientRequest.get("/users", { urlParams: { login: logins } }),
            token,
          ),
        )).data;
      },
      (effect) => effect.pipe(Effect.mapError(accountError)),
    ),
    list: Effect.fnUntraced(
      function* (token: string) {
        const subscriptions: Subscription[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;

        do {
          const page = yield* decodeBody(Page)(
            yield* checked(
              HttpClientRequest.get("/eventsub/subscriptions", {
                urlParams: cursor ? { after: cursor } : {},
              }),
              token,
            ),
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
      (effect) => effect.pipe(Effect.mapError(accountError)),
    ),
    create: Effect.fnUntraced(
      function* (token: string, channel: string, sender: string) {
        return yield* request<
          typeof CreateOutcome.Type,
          AccountError | ProviderError,
          never
        >(
          authenticated(helix, token, "Bearer"),
          HttpClientRequest.post("/eventsub/subscriptions").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              type: "channel.chat.message",
              version: "1",
              condition: { broadcaster_user_id: channel, user_id: sender },
              transport: {
                method: "webhook",
                callback: config.callback,
                secret: Redacted.value(config.signingSecret),
              },
            }),
          ),
          Effect.fnUntraced(function* (response) {
            const body = yield* readAcceptedJson(response);

            return yield* HttpClientResponse.matchStatus(response, {
              401: () => new AccountError({ code: "client" }),
              409: () =>
                Effect.succeed<typeof CreateOutcome.Type>({ kind: "conflict" }),
              202: Effect.fnUntraced(function* () {
                const {
                  data: [subscription],
                } = yield* decodeBody(Creation)(body);

                if (
                  subscription.type !== "channel.chat.message" ||
                  subscription.version !== "1" ||
                  subscription.transport.method !== "webhook" ||
                  subscription.transport.callback !== config.callback ||
                  subscription.condition.broadcaster_user_id !== channel ||
                  subscription.condition.user_id !== sender ||
                  (subscription.status !== "enabled" &&
                    subscription.status !==
                      "webhook_callback_verification_pending")
                )
                  return {
                    kind: "unknown",
                  } satisfies typeof CreateOutcome.Type;

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
              }),
              orElse: () =>
                Effect.succeed<typeof CreateOutcome.Type>({ kind: "unknown" }),
            });
          }),
        );
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
        yield* request(
          authenticated(helix, token, "Bearer"),
          HttpClientRequest.delete("/eventsub/subscriptions", {
            urlParams: { id },
          }),
          Effect.fnUntraced(function* (response) {
            yield* readAcceptedJson(response);

            return yield* HttpClientResponse.matchStatus(response, {
              401: () => new AccountError({ code: "client" }),
              204: () => Effect.void,
              404: () => Effect.void,
              orElse: () => new AccountError({ code: "provider" }),
            });
          }),
        );
      },
      (effect) => effect.pipe(Effect.mapError(accountError)),
    ),
    send: Effect.fnUntraced(
      function* (
        token: string,
        sender: string,
        input: Dispatch,
      ): Effect.fn.Return<SendResult, ProviderError> {
        const now = yield* Clock.currentTimeMillis;

        if (now >= input.deadline) return { kind: "expired" };

        return yield* request(
          authenticated(helix, token, "Bearer"),
          HttpClientRequest.post("/chat/messages").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              broadcaster_id: input.broadcasterId,
              sender_id: sender,
              message: input.text,
              reply_parent_message_id: input.replyParentId,
              for_source_only: true,
            }),
          ),
          Effect.fnUntraced(function* (response) {
            const body = yield* readAcceptedJson(response);

            const limits = yield* Schema.decodeUnknownEffect(RateLimitHeaders)(
              response.headers,
            ).pipe(Effect.orDie);

            const budget =
              limits.exhausted && limits.reset > now
                ? { blockedUntil: limits.reset }
                : {};

            return yield* HttpClientResponse.matchStatus(response, {
              401: () =>
                Effect.succeed<SendResult>({ kind: "unauthorized", ...budget }),
              429: Effect.fnUntraced(function* (): Effect.fn.Return<
                SendResult,
                ProviderError
              > {
                const now = yield* Clock.currentTimeMillis;

                return {
                  kind: "limited",
                  retryAt: Math.max(now + 1_000, limits.reset),
                };
              }),
              400: () =>
                Effect.succeed<SendResult>({
                  kind: "rejected",
                  code: "http-400",
                  ...budget,
                }),
              403: () =>
                Effect.succeed<SendResult>({
                  kind: "rejected",
                  code: "http-403",
                  ...budget,
                }),
              422: () =>
                Effect.succeed<SendResult>({
                  kind: "rejected",
                  code: "http-422",
                  ...budget,
                }),
              200: Effect.fnUntraced(function* (): Effect.fn.Return<
                SendResult,
                ProviderError
              > {
                const decoded = yield* decodeBody(Sent)(body);

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
              }),
              orElse: () => Effect.succeed<SendResult>({ kind: "ambiguous" }),
            });
          }),
          Math.min(4_000, input.deadline - now),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catch(() => Effect.succeed<SendResult>({ kind: "ambiguous" })),
        ),
    ),
  });
});

export const providerLayer = (
  config: ProviderConfig,
  endpoints?: Parameters<typeof makeProvider>[1],
) => Layer.effect(TwitchProvider, makeProvider(config, endpoints));
