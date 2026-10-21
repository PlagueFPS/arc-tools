import { commands } from "@arctools/commands";
import {
  Cause,
  Clock,
  Effect,
  Match,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import {
  type HttpServerError,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { BotApi } from "./api.js";
import type { EnvironmentConfig } from "./config.js";
import { BroadcasterId, GuildId } from "./contracts.js";
import { discordResponse, friendlyFailure } from "./presentation.js";
import { digest } from "./provider-http.js";
import {
  DiscordReceipt,
  Invocation,
  TenantError,
  Tenants,
  TwitchReceipt,
} from "./tenant-contracts.js";
import { tenantPolicy } from "./tenant-state.js";
import { subscriptionBinding } from "./twitch-binding.js";
import { bounded, TwitchAccount } from "./twitch-contracts.js";

export class IngressError extends Schema.TaggedError<IngressError>()(
  "IngressError",
  { status: Schema.Literals([400, 401, 408, 413]) },
) {}

type IngressBodyError = HttpServerError.HttpServerError | IngressError;

export const ingressPolicy = {
  maxBytes: 64 * 1024,
  bodyMs: 750,
  twitchAgeMs: 600_000,
  discordAgeMs: 300_000,
  futureSkewMs: 30_000,
} as const;

const TwitchAuthenticationHeaders = Schema.Struct({
  "twitch-eventsub-message-id": bounded(128),
  "twitch-eventsub-message-timestamp": Schema.String.check(
    Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/),
  ),
  "twitch-eventsub-message-signature": Schema.String.check(
    Schema.isPattern(/^sha256=[a-fA-F0-9]{64}$/),
  ),
});

const DiscordAuthenticationHeaders = Schema.Struct({
  "x-signature-timestamp": Schema.String.check(Schema.isPattern(/^\d{1,12}$/)),
  "x-signature-ed25519": Schema.String.check(
    Schema.isPattern(/^[a-fA-F0-9]{128}$/),
  ),
});

const TwitchDeliveryType = Schema.Literals([
  "notification",
  "revocation",
  "webhook_callback_verification",
]);

const combined = (prefix: string, body: Uint8Array) => {
  const head = new TextEncoder().encode(prefix);
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);

  return bytes;
};

export const readBody = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const length = request.headers["content-length"];

  if (
    Predicate.isNotUndefined(length) &&
    (!/^\d+$/.test(length) || Number(length) > ingressPolicy.maxBytes)
  )
    return yield* new IngressError({
      status: /^\d+$/.test(length) ? 413 : 400,
    });

  return yield* request.stream.pipe(
    Stream.limitBytes<IngressBodyError, never>(ingressPolicy.maxBytes, () =>
      Stream.fail(new IngressError({ status: 413 })),
    ),
    Stream.mkUint8Array,
    Effect.timeout(ingressPolicy.bodyMs),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "IngressError")
        ? error
        : new IngressError({
            status: Predicate.isTagged(error, "TimeoutError") ? 408 : 400,
          }),
    ),
  );
});

const fresh = (timestamp: number, receivedAt: number, age: number) =>
  Number.isFinite(timestamp) &&
  timestamp >= receivedAt - age &&
  timestamp <= receivedAt + ingressPolicy.futureSkewMs;

export const verifyTwitch = Effect.fnUntraced(function* (
  headers: HttpServerRequest.HttpServerRequest["headers"],
  bytes: Uint8Array,
  receivedAt: number,
  secret: Redacted.Redacted<string>,
) {
  const authentication = yield* Schema.decodeUnknownEffect(
    TwitchAuthenticationHeaders,
  )(headers).pipe(Effect.mapError(() => new IngressError({ status: 401 })));

  const id = authentication["twitch-eventsub-message-id"];
  const timestamp = authentication["twitch-eventsub-message-timestamp"];

  const signature = yield* Hex.decode(
    authentication["twitch-eventsub-message-signature"].slice(7),
  ).pipe(
    Effect.fromResult,
    Effect.mapError(() => new IngressError({ status: 401 })),
  );

  if (!fresh(Date.parse(timestamp), receivedAt, ingressPolicy.twitchAgeMs))
    return yield* new IngressError({ status: 401 });

  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      return await crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(signature),
        combined(id + timestamp, bytes),
      );
    },
    catch: () => new IngressError({ status: 401 }),
  });

  if (!valid) return yield* new IngressError({ status: 401 });

  return id;
});

export const verifyDiscord = Effect.fnUntraced(function* (
  headers: HttpServerRequest.HttpServerRequest["headers"],
  bytes: Uint8Array,
  receivedAt: number,
  publicKey: string,
) {
  const authentication = yield* Schema.decodeUnknownEffect(
    DiscordAuthenticationHeaders,
  )(headers).pipe(Effect.mapError(() => new IngressError({ status: 401 })));

  const timestamp = authentication["x-signature-timestamp"];

  const signature = yield* Hex.decode(
    authentication["x-signature-ed25519"],
  ).pipe(
    Effect.fromResult,
    Effect.mapError(() => new IngressError({ status: 401 })),
  );

  const keyBytes = yield* Hex.decode(publicKey).pipe(
    Effect.fromResult,
    Effect.mapError(() => new IngressError({ status: 401 })),
  );

  if (!fresh(Number(timestamp) * 1000, receivedAt, ingressPolicy.discordAgeMs))
    return yield* new IngressError({ status: 401 });

  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyBytes),
        { name: "Ed25519" },
        false,
        ["verify"],
      );

      return await crypto.subtle.verify(
        "Ed25519",
        key,
        new Uint8Array(signature),
        combined(timestamp, bytes),
      );
    },
    catch: () => new IngressError({ status: 401 }),
  });

  if (!valid) return yield* new IngressError({ status: 401 });
});

const decode = Effect.fnUntraced(function* <A, I>(
  bytes: Uint8Array,
  schema: Schema.Codec<A, I>,
) {
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => new IngressError({ status: 400 }),
  });

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    text,
  ).pipe(Effect.mapError(() => new IngressError({ status: 400 })));
});

export function parseTwitchCommand(
  text: string,
): typeof Invocation.Type | null {
  if (!text.startsWith("!")) return null;
  const [name, ...args] = text.slice(1).trim().split(/\s+/);
  const command = commands.find((entry) => entry.name === name?.toLowerCase());

  if (!command) return null;
  const input = args.join(" ");

  return input.length <= 256 ? { command: command.name, input } : null;
}

const Subscription = Schema.Struct({
  id: bounded(128),
  status: bounded(128),
  type: Schema.Literal("channel.chat.message"),
  version: Schema.Literal("1"),
  condition: Schema.Struct({
    broadcaster_user_id: BroadcasterId,
    user_id: bounded(64),
  }),
  transport: Schema.Struct({
    method: Schema.Literal("webhook"),
    callback: bounded(512),
  }),
});

const TwitchEnvelope = Schema.Struct({
  subscription: Subscription,
  challenge: Schema.optional(bounded(4096)),
  event: Schema.optional(
    Schema.Struct({
      broadcaster_user_id: BroadcasterId,
      broadcaster_user_login: bounded(25),
      chatter_user_id: bounded(64),
      message_id: bounded(128),
      message: Schema.Struct({
        text: Schema.String.check(Schema.isMaxLength(4096)),
      }),
    }),
  ),
});

const DiscordEnvelope = Schema.Struct({
  application_id: Schema.String,
  type: Schema.Int,
});

const DiscordCommand = Schema.Struct({
  application_id: Schema.String,
  id: DiscordReceipt.fields.id,
  type: Schema.Literal(2),
  context: Schema.Literal(0),
  guild_id: GuildId.check(Schema.isMaxLength(64)),
  member: Schema.Struct({ user: Schema.Struct({ id: bounded(64) }) }),
  authorizing_integration_owners: Schema.Struct({
    "0": GuildId.check(Schema.isMaxLength(64)),
  }),
  data: Schema.Struct({
    type: Schema.Literal(1),
    name: Schema.String,
    options: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.Literal(3),
          value: Schema.String.check(Schema.isMaxLength(256)),
        }),
      ),
    ),
  }),
});

const privateReply = (text = friendlyFailure) =>
  HttpServerResponse.jsonUnsafe(discordResponse(text, true), {
    headers: { "Cache-Control": "no-store" },
  });

export interface IngressConfig {
  readonly identity: EnvironmentConfig;
  readonly twitchSigningSecret: Redacted.Redacted<string>;
  readonly discordPublicKey: string;
  readonly callback: string;
  readonly receivedAt: number;
}

export const ingressHandlers = (config: IngressConfig) =>
  HttpApiBuilder.group(BotApi, "ingress", (handlers) =>
    Effect.gen(function* () {
      const account = yield* TwitchAccount;
      const tenants = yield* Tenants;

      const twitch = Effect.fnUntraced(function* (
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const bytes = yield* readBody(request);
        yield* verifyTwitch(
          request.headers,
          bytes,
          config.receivedAt,
          config.twitchSigningSecret,
        );
        const envelope = yield* decode(bytes, TwitchEnvelope);
        const subscription = envelope.subscription;

        if (
          request.headers["twitch-eventsub-subscription-type"] !==
            subscription.type ||
          request.headers["twitch-eventsub-subscription-version"] !==
            subscription.version ||
          subscription.transport.callback !== config.callback
        )
          return yield* new IngressError({ status: 400 });
        const status = yield* account.status();
        const sender = status.sender;

        const channel = status.channels.find(
          (channel) =>
            channel.id === subscription.condition.broadcaster_user_id &&
            config.identity.channelLogins.includes(channel.login),
        );

        if (!channel || !sender || sender.id !== subscription.condition.user_id)
          return yield* new IngressError({ status: 400 });

        const type = yield* Schema.decodeUnknownEffect(TwitchDeliveryType)(
          request.headers["twitch-eventsub-message-type"],
        ).pipe(Effect.mapError(() => new IngressError({ status: 400 })));

        const valid = Match.value(type).pipe(
          Match.when(
            "webhook_callback_verification",
            () =>
              !!envelope.challenge &&
              subscription.status === "webhook_callback_verification_pending",
          ),
          Match.when(
            "notification",
            () =>
              subscription.status === "enabled" &&
              !!envelope.event &&
              envelope.event.broadcaster_user_id === channel.id &&
              envelope.event.broadcaster_user_login === channel.login,
          ),
          Match.when("revocation", () =>
            [
              "authorization_revoked",
              "user_removed",
              "notification_failures_exceeded",
              "version_removed",
            ].includes(subscription.status),
          ),
          Match.exhaustive,
        );

        if (!valid) return yield* new IngressError({ status: 400 });
        yield* account.observeSubscription({
          id: subscription.id,
          broadcasterId: channel.id,
          senderId: sender.id,
          status:
            type === "webhook_callback_verification"
              ? "webhook_callback_verification_pending"
              : subscription.status,
          callback: config.callback,
          binding: yield* subscriptionBinding({
            callback: config.callback,
            clientId: config.identity.twitchClientId,
            signingSecret: config.twitchSigningSecret,
          }),
        });

        return yield* Match.value(type).pipe(
          Match.when("webhook_callback_verification", () =>
            Effect.succeed(
              HttpServerResponse.text(envelope.challenge ?? "", {
                headers: {
                  "Content-Length": String(
                    new TextEncoder().encode(envelope.challenge).byteLength,
                  ),
                },
              }),
            ),
          ),
          Match.when("revocation", () =>
            Effect.succeed(HttpServerResponse.empty({ status: 204 })),
          ),
          Match.when("notification", () =>
            Effect.gen(function* () {
              const event = envelope.event;

              if (!event) return yield* new IngressError({ status: 400 });

              if (
                config.identity.kind === "production" &&
                event.chatter_user_id === sender.id
              )
                return HttpServerResponse.empty({ status: 204 });
              const invocation = parseTwitchCommand(event.message.text);

              if (!invocation) return HttpServerResponse.empty({ status: 204 });

              const receipt = yield* Schema.decodeUnknownEffect(TwitchReceipt)({
                id: `twitch:${yield* digest(JSON.stringify([channel.id, event.message_id]))}`,
                broadcasterId: channel.id,
                replyParentId: event.message_id,
                invocation,
                receivedAt: config.receivedAt,
                fingerprint: yield* digest(
                  JSON.stringify([
                    channel.id,
                    event.message_id,
                    event.chatter_user_id,
                    invocation,
                  ]),
                ),
              }).pipe(Effect.mapError(() => new IngressError({ status: 400 })));

              yield* tenants.acceptTwitch(receipt);

              return HttpServerResponse.empty({ status: 204 });
            }),
          ),
          Match.exhaustive,
        );
      });

      const discord = Effect.fnUntraced(function* (
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const bytes = yield* readBody(request);
        yield* verifyDiscord(
          request.headers,
          bytes,
          config.receivedAt,
          config.discordPublicKey,
        );
        const header = yield* decode(bytes, DiscordEnvelope);

        if (header.application_id !== config.identity.discordApplicationId)
          return privateReply(
            "This interaction belongs to a different application.",
          );

        if (header.type === 1)
          return HttpServerResponse.jsonUnsafe({ type: 1 });

        const command = yield* decode(bytes, DiscordCommand).pipe(
          Effect.result,
        );

        if (Result.isFailure(command))
          return privateReply("Use a slash command from an installed server.");
        const value = command.success;

        if (value.guild_id !== value.authorizing_integration_owners["0"])
          return privateReply("Use a slash command from an installed server.");

        const definition = commands.find(
          (entry) => entry.name === value.data.name,
        );

        if (!definition) return privateReply("Command not found");
        const options = value.data.options ?? [];

        if (
          options.length !== definition.slashOptions.length ||
          options.some(
            (option) =>
              !definition.slashOptions.some(
                (expected) => expected.name === option.name,
              ),
          ) ||
          new Set(options.map((option) => option.name)).size !== options.length
        )
          return privateReply("Invalid command options.");

        const invocation = yield* Schema.decodeUnknownEffect(Invocation)({
          command: definition.name,
          input: definition.slashOptions
            .flatMap((option) => {
              const input = options
                .find((entry) => entry.name === option.name)
                ?.value.trim();

              return input ? [input] : [];
            })
            .join(" "),
        }).pipe(Effect.mapError(() => new IngressError({ status: 400 })));

        const receipt: DiscordReceipt = {
          id: value.id,
          guildId: value.guild_id,
          invocation,
          receivedAt: config.receivedAt,
          fingerprint: yield* digest(
            JSON.stringify([
              value.id,
              value.guild_id,
              value.member.user.id,
              invocation,
            ]),
          ),
        };

        const remaining =
          config.receivedAt +
          tenantPolicy.rpcMs -
          (yield* Clock.currentTimeMillis);

        if (remaining <= 0)
          return HttpServerResponse.setHeaders(privateReply(), {
            "x-arc-command-fallback": "worker",
            "x-arc-command-code": "ingress-budget",
          });

        return yield* tenants.respondDiscord(receipt).pipe(
          Effect.timeout(remaining),
          Effect.map((reply) =>
            HttpServerResponse.jsonUnsafe(reply, {
              headers: { "Cache-Control": "no-store" },
            }),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt;

            const error = cause.reasons.find((reason) =>
              Predicate.isTagged(reason, "Fail"),
            );

            const code =
              error?._tag === "Fail" && Schema.is(TenantError)(error.error)
                ? error.error.code
                : error?._tag === "Fail" && Cause.isTimeoutError(error.error)
                  ? "rpc-timeout"
                  : Cause.hasDies(cause)
                    ? "rpc-defect"
                    : "rpc-failure";

            return Effect.logWarning("Discord Worker fallback").pipe(
              Effect.annotateLogs({ phase: "worker-fallback", code }),
              Effect.as(
                HttpServerResponse.setHeaders(privateReply(), {
                  "x-arc-command-fallback": "worker",
                  "x-arc-command-code": code,
                }),
              ),
            );
          }),
        );
      });

      const guarded = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt;

            const errors = [...cause.reasons].flatMap((reason) =>
              Predicate.isTagged(reason, "Fail") &&
              Schema.is(IngressError)(reason.error)
                ? [reason.error]
                : [],
            );

            const status = errors[0]?.status ?? 503;

            return Effect.logWarning("Ingress response failure").pipe(
              Effect.annotateLogs({
                phase: "ingress",
                code:
                  status === 503
                    ? Cause.hasDies(cause)
                      ? "infrastructure-defect"
                      : "infrastructure-failure"
                    : "invalid-request",
                status,
              }),
              Effect.as(HttpServerResponse.empty({ status })),
            );
          }),
        );

      return handlers
        .handleRaw("twitch", ({ request }) => guarded(twitch(request)))
        .handleRaw("discord", ({ request }) => guarded(discord(request)));
    }),
  );
