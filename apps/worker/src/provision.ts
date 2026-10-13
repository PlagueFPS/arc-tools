import { commands } from "@arctools/commands";
import { Effect, Schema } from "effect";
import { DeliveryId, DiscordId, TwitchId, WebhookSecret } from "./domain.ts";
import { HttpFailure, requestJson } from "./platform.ts";

export const discordCommandPayload = () =>
  commands.map((command) => ({
    type: 1,
    name: command.name,
    description: command.description,
    integration_types: [0],
    contexts: [0],
    options: command.slashOptions.map((option) => ({
      type: 3,
      name: option.name,
      description: option.description,
      required: option.required ?? true,
    })),
  }));
export const provisionDiscord = Effect.fnUntraced(function* (options: {
  applicationId: string;
  botToken: string;
  apiBase?: string;
}) {
  const applicationId = yield* Schema.decodeUnknownEffect(DiscordId)(
    options.applicationId,
  );
  const result = yield* requestJson(
    `${options.apiBase ?? "https://discord.com/api/v10"}/applications/${applicationId}/commands`,
    {
      method: "PUT",
      headers: {
        authorization: `Bot ${options.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(discordCommandPayload()),
    },
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ id: DiscordId, name: Schema.String })),
  )(result);
});
const Subscription = Schema.Struct({
  id: DeliveryId,
  type: Schema.String,
  version: Schema.String,
  status: Schema.String,
  condition: Schema.Struct({
    broadcaster_user_id: Schema.optional(TwitchId),
    user_id: Schema.optional(TwitchId),
  }),
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.optional(Schema.String),
  }),
});
const Created = Schema.Struct({
  data: Schema.Array(Subscription).check(Schema.isMinLength(1)),
  total: Schema.Number,
  total_cost: Schema.Number,
  max_total_cost: Schema.Number,
});
const Page = Schema.Struct({
  data: Schema.Array(Subscription),
  pagination: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
});
export const provisionTwitch = Effect.fnUntraced(function* (options: {
  clientId: string;
  appToken: string;
  botId: string;
  channels: readonly string[];
  callback: string;
  secret: string;
  apiBase?: string;
  recreate?: boolean;
}) {
  const config = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      botId: TwitchId,
      channels: Schema.Array(TwitchId).check(Schema.isMinLength(1)),
      callback: Schema.String.check(Schema.isPattern(/^https:\/\//)),
      secret: WebhookSecret,
    }),
  )(options);
  const base = options.apiBase ?? "https://api.twitch.tv/helix";
  const headers = {
    "client-id": options.clientId,
    authorization: `Bearer ${options.appToken}`,
    "content-type": "application/json",
  };
  const subscriptions = new Map<string, typeof Subscription.Type>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = new URL(`${base}/eventsub/subscriptions`);
    if (cursor !== undefined) url.searchParams.set("after", cursor);
    const page = yield* requestJson(url.href, { headers }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Page)),
    );
    for (const subscription of page.data)
      subscriptions.set(subscription.id, subscription);
    cursor = page.pagination.cursor;
    if (cursor !== undefined && seenCursors.has(cursor))
      return yield* new HttpFailure({
        status: 0,
        retryable: false,
        retryAfter: 0,
        cause: "Repeated Twitch pagination cursor",
      });
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  let created = 0;
  let deleted = 0;
  for (const broadcasterId of new Set(config.channels)) {
    const matches = Array.from(subscriptions.values()).filter(
      (subscription) =>
        subscription.type === "channel.chat.message" &&
        subscription.version === "1" &&
        subscription.condition.broadcaster_user_id === broadcasterId &&
        subscription.condition.user_id === config.botId &&
        subscription.transport.method === "webhook" &&
        subscription.transport.callback === config.callback,
    );
    const keeper = options.recreate
      ? undefined
      : matches.find(
          (subscription) =>
            subscription.status === "enabled" ||
            subscription.status === "webhook_callback_verification_pending",
        );
    for (const subscription of matches) {
      if (subscription.id === keeper?.id) continue;
      yield* requestJson(
        `${base}/eventsub/subscriptions?id=${encodeURIComponent(subscription.id)}`,
        { method: "DELETE", headers },
      );
      deleted++;
    }
    if (keeper !== undefined) continue;
    yield* requestJson(`${base}/eventsub/subscriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: broadcasterId,
          user_id: config.botId,
        },
        transport: {
          method: "webhook",
          callback: config.callback,
          secret: config.secret,
        },
      }),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Created)));
    created++;
  }
  return { created, deleted };
});
