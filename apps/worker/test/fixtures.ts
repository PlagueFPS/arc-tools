import { packEnvValue } from "alchemy/RuntimeContext";
import { Redacted } from "effect";
import {
  convertV4MiniflareOptions,
  type DurableObjectStorageHandle,
  Miniflare,
} from "miniflare";
import { expect } from "vitest";
import { workerCompatibility } from "../src/config.ts";

const encoder = new TextEncoder();
export const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);
if (!("publicKey" in keys))
  throw new Error("Ed25519 did not produce a key pair");
export const publicKey = Buffer.from(
  await crypto.subtle.exportKey("raw", keys.publicKey),
).toString("hex");
export const bindings = {
  DISCORD_APPLICATION_ID: "123",
  DISCORD_PUBLIC_KEY: publicKey,
  TWITCH_BOT_USER_ID: "999",
  TWITCH_WEBHOOK_SECRET: "local-webhook-secret",
  TWITCH_CHANNEL_IDS: "101,202",
  TWITCH_CLIENT_ID: "local-client",
  TWITCH_CLIENT_SECRET: "local-client-secret",
};
export const subscription = (channel = "101") => ({
  id: "subscription-1",
  type: "channel.chat.message",
  version: "1",
  status: "enabled",
  condition: { broadcaster_user_id: channel, user_id: "999" },
  transport: {
    method: "webhook",
    callback: "https://bot.test/webhooks/twitch",
  },
});
export const twitchBody = (text = "!sell sensors", channel = "101") => ({
  subscription: subscription(channel),
  event: {
    broadcaster_user_id: channel,
    chatter_user_id: "888",
    message_id: "chat-message-1",
    message: { text },
  },
});
export const slash = (name = "sell", guild = "101", id = "111") => ({
  type: 2,
  id,
  application_id: "123",
  guild_id: guild,
  token: `interaction-token-${guild}-${id}`,
  data: {
    type: 1,
    name,
    options: [{ type: 3, name: "item", value: "sensors" }],
  },
});
export async function twitchRequest(
  body: unknown,
  id = "delivery-1",
  timestamp = new Date().toISOString(),
) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(bindings.TWITCH_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, encoder.encode(id + timestamp + raw)),
  ).toString("hex");
  return {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": `sha256=${signature}`,
      "twitch-eventsub-message-type": "notification",
      "twitch-eventsub-subscription-type": "channel.chat.message",
      "twitch-eventsub-subscription-version": "1",
    },
  };
}
export async function discordRequest(
  body: unknown,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  if (!("privateKey" in keys)) throw new Error("Missing signing key");
  const raw = JSON.stringify(body);
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      encoder.encode(timestamp + raw),
    ),
  ).toString("hex");
  return {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    },
  };
}
export const item = {
  id: "sensors",
  name: "Sensors",
  value: 42,
  workbench: "Workbench II",
  loot_area: "Industrial",
  components: [{ quantity: 2, component: { id: "wire", name: "Wire" } }],
  recycle_components: [
    { quantity: 3, component: { id: "wire", name: "Wire" } },
  ],
  recycle_from: [{ quantity: 4, item: { id: "radio", name: "Radio" } }],
  dropped_by: [{ arc: { id: "bastion", name: "Bastion" } }],
};
export const json = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export type Outbound = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};
export class ExternalFixtures {
  calls: Outbound[] = [];
  discordStatus = 200;
  twitchStatus = 200;
  dataStatus = 200;
  tokenStatus = 200;
  events: Array<{
    name: string;
    map: string;
    startTime: number;
    endTime: number;
  }> = [];
  twitchResponse: unknown = { data: [{ message_id: "sent-1", is_sent: true }] };
  override:
    | ((call: Outbound) => Promise<Response> | Response | undefined)
    | undefined;
  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = await request.text();
    const body: unknown =
      text === ""
        ? undefined
        : request.headers.get("content-type")?.includes("application/json")
          ? JSON.parse(text)
          : Object.fromEntries(new URLSearchParams(text));
    const call = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    };
    this.calls.push(call);
    const override = this.override?.(call);
    if (override !== undefined) return override;
    if (url.hostname === "id.twitch.tv")
      return json(
        {
          access_token: "local-app-token",
          expires_in: 3600,
          token_type: "bearer",
        },
        this.tokenStatus,
      );
    if (url.hostname === "api.twitch.tv")
      return json(this.twitchResponse, this.twitchStatus, {
        "retry-after": "1",
      });
    if (url.hostname === "discord.com")
      return json({ id: "1000" }, this.discordStatus, { "retry-after": "1" });
    if (url.hostname === "metaforge.app") {
      if (this.dataStatus !== 200)
        return json({ error: "fixture failure" }, this.dataStatus);
      if (url.pathname.endsWith("/events-schedule"))
        return json({ data: this.events });
      if (url.pathname.endsWith("/items")) {
        const id = url.searchParams.get("id");
        const search = url.searchParams.get("search");
        return json({
          data:
            id === "sensors" || search === "sensors" || search === "sensor"
              ? [item]
              : [],
        });
      }
      if (url.pathname.endsWith("/arcs"))
        return json({
          data:
            url.searchParams.get("id") === "bastion"
              ? [
                  {
                    id: "bastion",
                    name: "Bastion",
                    loot: [{ item: { id: "sensors", name: "Sensors" } }],
                  },
                ]
              : [],
        });
      if (url.pathname.endsWith("/traders"))
        return json({
          data: {
            Apollo: [{ id: "sensors", name: "Sensors", trader_price: 50 }],
            Celeste: [],
            Lance: [],
            Shani: [],
            TianWen: [],
          },
        });
    }
    throw new Error(`Unexpected external request ${url.origin}${url.pathname}`);
  };
  discordReplies() {
    return this.calls.filter((call) =>
      call.url.startsWith("https://discord.com/"),
    );
  }
  twitchReplies() {
    return this.calls.filter(
      (call) => call.url === "https://api.twitch.tv/helix/chat/messages",
    );
  }
}
export const createWorker = (
  fixtures: ExternalFixtures,
  persistence?: string,
  config = bindings,
) =>
  new Miniflare({
    ...convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      cf: false,
      workers: [
        {
          name: "ArcBot",
          modules: true,
          scriptPath: "dist/worker.js",
          compatibilityDate: workerCompatibility.date,
          compatibilityFlags: workerCompatibility.flags,
          bindings: Object.fromEntries(
            Object.entries(config).map(([key, value]) => [
              key,
              packEnvValue(Redacted.make(value)),
            ]),
          ),
          durableObjects: {
            TwitchChannel: { className: "TwitchChannel", useSQLite: true },
            DiscordGuild: { className: "DiscordGuild", useSQLite: true },
          },
          outboundService: fixtures.fetch,
        },
      ],
    }),
    resourcePersistencePath: persistence,
  });
export const discord = (
  mf: Miniflare,
  request: Awaited<ReturnType<typeof discordRequest>>,
) => mf.dispatchFetch("https://bot.test/webhooks/discord", request);
export const twitch = (
  mf: Miniflare,
  request: Awaited<ReturnType<typeof twitchRequest>>,
) => mf.dispatchFetch("https://bot.test/webhooks/twitch", request);
export const storage = (
  mf: Miniflare,
  kind: "DiscordGuild" | "TwitchChannel",
  name = "101",
) => mf.unsafeGetDurableObjectStorage("ArcBot", kind, { name });
export const rows = (storage: DurableObjectStorageHandle) =>
  storage.exec("SELECT key,data FROM bot_jobs ORDER BY key");
export async function terminalJob(
  store: DurableObjectStorageHandle,
  key: string,
) {
  await expect
    .poll(
      async () =>
        store.exec(
          "SELECT json_extract(data, '$.kind') AS kind FROM bot_jobs WHERE key = ?",
          key,
        ),
      { timeout: 40000 },
    )
    .toEqual([{ kind: "terminal" }]);
  const saved = await store.exec(
    "SELECT data FROM bot_jobs WHERE key = ?",
    key,
  );
  expect(saved).toEqual([
    { data: expect.stringMatching(/^\{"kind":"terminal","expiresAt":\d+\}$/) },
  ]);
}
