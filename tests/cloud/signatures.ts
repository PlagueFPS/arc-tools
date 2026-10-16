import { Effect } from "effect";
export const discordPublicKey =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
const concat = (prefix: string, body: Uint8Array) => {
  const first = new TextEncoder().encode(prefix);
  const result = new Uint8Array(first.length + body.length);
  result.set(first);
  result.set(body, first.length);
  return result;
};
export const signDiscord = Effect.fnUntraced(function* (
  body: Uint8Array,
  now = Date.now(),
) {
  const timestamp = String(Math.floor(now / 1000));
  const signature = yield* Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes(
        "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      ),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return hex(
      await crypto.subtle.sign("Ed25519", key, concat(timestamp, body)),
    );
  });
  return {
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": signature,
    "content-type": "application/json",
  };
});
export const signTwitch = Effect.fnUntraced(function* (
  body: Uint8Array,
  id: string,
  now = Date.now(),
  type = "notification",
) {
  const timestamp = new Date(now).toISOString();
  const signature = yield* Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("fixture-signing"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(
      await crypto.subtle.sign("HMAC", key, concat(id + timestamp, body)),
    );
  });
  return {
    "twitch-eventsub-message-id": id,
    "twitch-eventsub-message-timestamp": timestamp,
    "twitch-eventsub-message-signature": `sha256=${signature}`,
    "twitch-eventsub-message-type": type,
    "twitch-eventsub-subscription-type": "channel.chat.message",
    "twitch-eventsub-subscription-version": "1",
    "content-type": "application/json",
  };
});
export const discordCommand = (
  id: string,
  command = "sell",
  input = "sensors",
  guild = "guild",
) => ({
  id,
  application_id: "fixture-discord",
  type: 2,
  context: 0,
  guild_id: guild,
  member: { user: { id: "user" } },
  authorizing_integration_owners: { "0": guild },
  token: "CANARY-INTERACTION-TOKEN",
  data: {
    type: 1,
    name: command,
    options: input
      ? [
          {
            type: 3,
            name:
              command === "loot"
                ? "arc"
                : command === "event"
                  ? "event_or_map"
                  : "item",
            value: input,
          },
        ]
      : [],
  },
});
export const twitchEvent = (
  id: string,
  text = "!sell sensors",
  callback = "https://bot.invalid/webhooks/twitch",
) => ({
  subscription: {
    id: "subscription",
    type: "channel.chat.message",
    version: "1",
    status: "enabled",
    condition: { broadcaster_user_id: "200", user_id: "100" },
    transport: { method: "webhook", callback },
  },
  event: {
    broadcaster_user_id: "200",
    broadcaster_user_login: "fixture_channel",
    chatter_user_id: "100",
    message_id: id,
    message: { text },
  },
});
