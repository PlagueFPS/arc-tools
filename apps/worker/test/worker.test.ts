import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  bindings,
  createWorker,
  discord,
  discordRequest,
  ExternalFixtures,
  json,
  rows,
  slash,
  storage,
  subscription,
  terminalJob,
  twitch,
  twitchBody,
  twitchRequest,
} from "./fixtures.ts";

const cases = [
  {
    name: "buy",
    input: "sensors",
    option: "item",
    text: "Sensors can be purchased from Apollo for 50 coins",
  },
  {
    name: "loot",
    input: "bastion",
    option: "arc",
    text: "Bastions drop the following items: Sensors",
  },
  {
    name: "craft",
    input: "sensors",
    option: "item",
    text: "You must have Workbench II and the following items to craft Sensors: Wire (x2)",
  },
  {
    name: "find",
    input: "sensors",
    option: "item",
    text: "Sensors can be found in Industrial areas and can be dropped by Bastion.",
  },
  {
    name: "sell",
    input: "sensors",
    option: "item",
    text: "Sensors can be sold for 42 coins each",
  },
  {
    name: "recycle",
    input: "sensors",
    option: "item",
    text: "These items are granted for recycling Sensors: Wire (x3)",
  },
  {
    name: "recycleto",
    input: "sensors",
    option: "item",
    text: "These items recycle to Sensors: Radio (x4)",
  },
  {
    name: "event",
    input: "missing",
    option: "event_or_map",
    text: "[Warn] No event or map found matching: missing",
  },
  { name: "upcoming", input: "", option: "", text: "No upcoming events" },
  { name: "active", input: "", option: "", text: "No active events" },
];

test("signed raw challenges and PING run through the deployed HttpApi", async () => {
  const mf = createWorker(new ExternalFixtures());
  try {
    const challenge = await twitchRequest({
      subscription: subscription(),
      challenge: "raw challenge",
    });
    challenge.headers["twitch-eventsub-message-type"] =
      "webhook_callback_verification";
    const response = await twitch(mf, challenge);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw challenge");
    expect(response.headers.get("content-type")).toContain("text/plain");
    const ping = await discord(
      mf,
      await discordRequest({ type: 1, application_id: "123" }),
    );
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ type: 1 });
    const revoked = await twitchRequest({
      subscription: { ...subscription(), status: "authorization_revoked" },
    });
    revoked.headers["twitch-eventsub-message-type"] = "revocation";
    expect((await twitch(mf, revoked)).status).toBe(204);
  } finally {
    await mf.dispose();
  }
});

test("signature, raw tamper, stale, future, IDs and subscription checks reject requests", async () => {
  const mf = createWorker(new ExternalFixtures());
  try {
    const badTwitch = await twitchRequest(twitchBody());
    badTwitch.headers["twitch-eventsub-message-signature"] =
      `sha256=${"00".repeat(32)}`;
    expect((await twitch(mf, badTwitch)).status).toBe(401);
    const tampered = await twitchRequest(twitchBody());
    tampered.body += " ";
    expect((await twitch(mf, tampered)).status).toBe(401);
    expect(
      (
        await twitch(
          mf,
          await twitchRequest(
            twitchBody(),
            "stale",
            new Date(Date.now() - 660000).toISOString(),
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await twitch(
          mf,
          await twitchRequest(
            twitchBody(),
            "future",
            new Date(Date.now() + 120000).toISOString(),
          ),
        )
      ).status,
    ).toBe(401);
    const missingId = await twitchRequest(twitchBody());
    missingId.headers["twitch-eventsub-message-id"] = "";
    expect((await twitch(mf, missingId)).status).toBe(400);
    const wrongVersion = await twitchRequest({
      ...twitchBody(),
      subscription: { ...subscription(), version: "2" },
    });
    expect((await twitch(mf, wrongVersion)).status).toBe(400);
    expect(
      (
        await twitch(
          mf,
          await twitchRequest({
            ...twitchBody(),
            subscription: {
              ...subscription(),
              condition: { broadcaster_user_id: "101", user_id: "777" },
            },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await twitch(
          mf,
          await twitchRequest({
            ...twitchBody(),
            event: { ...twitchBody().event, broadcaster_user_id: "202" },
          }),
        )
      ).status,
    ).toBe(403);
    const badDiscord = await discordRequest(slash());
    badDiscord.headers["x-signature-ed25519"] = "00".repeat(64);
    expect((await discord(mf, badDiscord)).status).toBe(401);
    const tamperedDiscord = await discordRequest(slash());
    tamperedDiscord.body += " ";
    expect((await discord(mf, tamperedDiscord)).status).toBe(401);
    expect(
      (
        await discord(
          mf,
          await discordRequest(
            slash(),
            String(Math.floor(Date.now() / 1000) - 360),
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await discord(
          mf,
          await discordRequest(
            slash(),
            String(Math.floor(Date.now() / 1000) + 120),
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await discord(
          mf,
          await discordRequest({ ...slash(), application_id: "321" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await discord(
          mf,
          await discordRequest({ ...slash(), id: "../invalid" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await discord(
          mf,
          await discordRequest({
            ...slash(),
            data: {
              type: 1,
              name: "sell",
              options: [{ type: 4, name: "item", value: 123 }],
            },
          }),
        )
      ).status,
    ).toBe(400);
  } finally {
    await mf.dispose();
  }
});

test("oversized unsigned bodies are bounded on the real workerd adapter", async () => {
  const mf = createWorker(new ExternalFixtures());
  try {
    for (const path of ["discord", "twitch"]) {
      const response = await mf.dispatchFetch(
        `https://bot.test/webhooks/${path}`,
        { method: "POST", body: "x".repeat(65537) },
      );
      expect(response.status).toBe(413);
    }
  } finally {
    await mf.dispose();
  }
});

test("unsupported commands and DMs are immediate ephemeral; self and unknown Twitch messages are ignored", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    const unknown = await discord(mf, await discordRequest(slash("unknown")));
    expect(await unknown.json()).toEqual({
      type: 4,
      data: {
        content: "Unknown command.",
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    const dm = { ...slash(), guild_id: undefined };
    const dmResponse = await discord(mf, await discordRequest(dm));
    expect(await dmResponse.json()).toEqual({
      type: 4,
      data: {
        content: "Commands are only available in a server.",
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    for (const options of [
      [],
      [{ name: "item", type: 3, value: "" }],
      [
        { name: "item", type: 3, value: "sensors" },
        { name: "item", type: 3, value: "sensors" },
      ],
      [{ name: "unknown", type: 3, value: "sensors" }],
    ]) {
      const response = await discord(
        mf,
        await discordRequest({
          ...slash(),
          data: { type: 1, name: "sell", options },
        }),
      );
      expect(await response.json()).toEqual({
        type: 4,
        data: {
          content: "Please provide the required command options.",
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      });
    }
    expect(
      (await twitch(mf, await twitchRequest(twitchBody("!unknown")))).status,
    ).toBe(204);
    expect(
      (
        await twitch(
          mf,
          await twitchRequest({
            ...twitchBody(),
            event: { ...twitchBody().event, chatter_user_id: "999" },
          }),
        )
      ).status,
    ).toBe(204);
    expect(fixtures.calls).toEqual([]);
  } finally {
    await mf.dispose();
  }
});

test("all ten command outputs reach public original-response edits", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    for (const [index, command] of cases.entries()) {
      const guild = String(100 + index);
      const id = String(1000 + index);
      const body = {
        ...slash(command.name, guild, id),
        data: {
          type: 1,
          name: command.name,
          options:
            command.option === ""
              ? []
              : [{ type: 3, name: command.option, value: command.input }],
        },
      };
      const ack = await discord(mf, await discordRequest(body));
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({
        type: 5,
        data: { allowed_mentions: { parse: [] } },
      });
    }
    await expect
      .poll(() => fixtures.discordReplies().length, { timeout: 5000 })
      .toBe(10);
    for (const [index, command] of cases.entries()) {
      expect(fixtures.discordReplies()).toContainEqual({
        url: `https://discord.com/api/v10/webhooks/123/interaction-token-${100 + index}-${1000 + index}/messages/@original`,
        method: "PATCH",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
        body: { content: command.text, allowed_mentions: { parse: [] } },
      });
      await terminalJob(
        await storage(mf, "DiscordGuild", String(100 + index)),
        String(1000 + index),
      );
    }
  } finally {
    await mf.dispose();
  }
});

test("concurrent duplicates and equal IDs in separate guilds produce one reply per guild", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    const signed = await discordRequest(slash());
    const acknowledgements = await Promise.all(
      Array.from({ length: 8 }, () => discord(mf, signed)),
    );
    for (const ack of acknowledgements)
      expect(await ack.json()).toEqual({
        type: 5,
        data: { allowed_mentions: { parse: [] } },
      });
    expect(
      (await discord(mf, await discordRequest(slash("sell", "202")))).status,
    ).toBe(200);
    await terminalJob(await storage(mf, "DiscordGuild", "101"), "111");
    await terminalJob(await storage(mf, "DiscordGuild", "202"), "111");
    expect(
      fixtures
        .discordReplies()
        .map((call) => call.url)
        .sort(),
    ).toEqual([
      "https://discord.com/api/v10/webhooks/123/interaction-token-101-111/messages/@original",
      "https://discord.com/api/v10/webhooks/123/interaction-token-202-111/messages/@original",
    ]);
  } finally {
    await mf.dispose();
  }
});

test("Twitch success without drop_reason sends the exact threaded Helix payload", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    const signed = await twitchRequest(twitchBody());
    const acks = await Promise.all(
      Array.from({ length: 6 }, () => twitch(mf, signed)),
    );
    for (const ack of acks) expect(ack.status).toBe(204);
    await terminalJob(await storage(mf, "TwitchChannel"), "delivery-1");
    expect(fixtures.twitchReplies()).toEqual([
      {
        url: "https://api.twitch.tv/helix/chat/messages",
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer local-app-token",
          "client-id": "local-client",
        }),
        body: {
          broadcaster_id: "101",
          sender_id: "999",
          reply_parent_message_id: "chat-message-1",
          message: "Sensors can be sold for 42 coins each",
        },
      },
    ]);
    expect(
      fixtures.calls.find((call) =>
        call.url.startsWith("https://id.twitch.tv/"),
      )?.body,
    ).toEqual({
      client_id: "local-client",
      client_secret: "local-client-secret",
      grant_type: "client_credentials",
    });
  } finally {
    await mf.dispose();
  }
});

test("equal Twitch delivery IDs remain isolated by broadcaster", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    for (const broadcaster of ["101", "202"])
      expect(
        (
          await twitch(
            mf,
            await twitchRequest(
              twitchBody("!sell sensors", broadcaster),
              "shared-delivery",
            ),
          )
        ).status,
      ).toBe(204);
    await terminalJob(
      await storage(mf, "TwitchChannel", "101"),
      "shared-delivery",
    );
    await terminalJob(
      await storage(mf, "TwitchChannel", "202"),
      "shared-delivery",
    );
    expect(fixtures.twitchReplies()).toHaveLength(2);
    expect(fixtures.twitchReplies().map((call) => call.body)).toEqual(
      expect.arrayContaining([
        {
          broadcaster_id: "101",
          sender_id: "999",
          reply_parent_message_id: "chat-message-1",
          message: "Sensors can be sold for 42 coins each",
        },
        {
          broadcaster_id: "202",
          sender_id: "999",
          reply_parent_message_id: "chat-message-1",
          message: "Sensors can be sold for 42 coins each",
        },
      ]),
    );
  } finally {
    await mf.dispose();
  }
});

test("accepted work and tombstones survive a full workerd restart", async () => {
  const path = await mkdtemp(join(tmpdir(), "arc-worker-"));
  const fixtures = new ExternalFixtures();
  let mf = createWorker(fixtures, path);
  try {
    const request = await discordRequest(slash());
    expect((await discord(mf, request)).status).toBe(200);
    const before = await rows(await storage(mf, "DiscordGuild"));
    expect(before).toEqual([
      { key: "111", data: expect.stringContaining('"kind":"execute"') },
    ]);
    await mf.dispose();
    mf = createWorker(fixtures, path);
    expect((await discord(mf, request)).status).toBe(200);
    await terminalJob(await storage(mf, "DiscordGuild"), "111");
    await mf.dispose();
    mf = createWorker(fixtures, path);
    expect((await discord(mf, request)).status).toBe(200);
    expect(fixtures.discordReplies()).toHaveLength(1);
    expect(await rows(await storage(mf, "DiscordGuild"))).toEqual([
      {
        key: "111",
        data: expect.stringMatching(/^\{"kind":"terminal","expiresAt":\d+\}$/),
      },
    ]);
  } finally {
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("reply retries preserve rendered event text and recover after restart", async () => {
  const path = await mkdtemp(join(tmpdir(), "arc-reply-"));
  const fixtures = new ExternalFixtures();
  fixtures.discordStatus = 429;
  fixtures.events = [
    {
      name: "Probes",
      map: "Bastion",
      startTime: 0,
      endTime: Date.now() + 30 * 60000 + 30000,
    },
  ];
  let mf = createWorker(fixtures, path);
  try {
    await discord(
      mf,
      await discordRequest({
        ...slash("active"),
        data: { type: 1, name: "active", options: [] },
      }),
    );
    await expect
      .poll(() => fixtures.discordReplies().length, { timeout: 5000 })
      .toBe(1);
    const saved = await rows(await storage(mf, "DiscordGuild"));
    expect(saved).toEqual([
      { key: "111", data: expect.stringContaining('"kind":"reply"') },
    ]);
    expect(fixtures.discordReplies()[0]?.body).toEqual({
      content: "Probes on Bastion (ends in 30m)",
      allowed_mentions: { parse: [] },
    });
    await mf.dispose();
    fixtures.events = [];
    fixtures.discordStatus = 200;
    mf = createWorker(fixtures, path);
    await terminalJob(await storage(mf, "DiscordGuild"), "111");
    expect(fixtures.discordReplies().map((call) => call.body)).toEqual([
      {
        content: "Probes on Bastion (ends in 30m)",
        allowed_mentions: { parse: [] },
      },
      {
        content: "Probes on Bastion (ends in 30m)",
        allowed_mentions: { parse: [] },
      },
    ]);
    expect(
      fixtures.calls.filter((call) => call.url.includes("events-schedule")),
    ).toHaveLength(1);
  } finally {
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("five failed attempts remove credentials, and expired tombstones stop scheduling", async () => {
  const fixtures = new ExternalFixtures();
  fixtures.discordStatus = 503;
  const mf = createWorker(fixtures);
  try {
    await discord(mf, await discordRequest(slash()));
    const store = await storage(mf, "DiscordGuild");
    await terminalJob(store, "111");
    expect(fixtures.discordReplies()).toHaveLength(5);
    await store.exec(
      "UPDATE bot_jobs SET data = json_set(data, '$.expiresAt', ?) WHERE key = '111'",
      Date.now() - 1,
    );
    await store.exec(
      "UPDATE alchemy_alarm_callbacks SET run_at = ? WHERE id = '111'",
      Date.now() - 1,
    );
    fixtures.discordStatus = 200;
    await discord(mf, await discordRequest(slash("sell", "101", "222")));
    await terminalJob(store, "222");
    expect(
      await store.exec("SELECT key FROM bot_jobs WHERE key = '111'"),
    ).toEqual([]);
    await store.exec(
      "UPDATE bot_jobs SET data = json_set(data, '$.expiresAt', ?)",
      Date.now() - 1,
    );
    await store.exec(
      "UPDATE alchemy_alarm_callbacks SET run_at = ?",
      Date.now() - 1,
    );
    await discord(mf, await discordRequest(slash("sell", "101", "333")));
    await store.exec(
      "UPDATE bot_jobs SET data = ?",
      JSON.stringify({ kind: "terminal", expiresAt: Date.now() - 1 }),
    );
    await expect
      .poll(() => store.exec("SELECT id FROM alchemy_alarm_callbacks"), {
        timeout: 5000,
      })
      .toEqual([]);
    expect(await rows(store)).toEqual([]);
  } finally {
    await mf.dispose();
  }
});

test("deadline expiry removes unexecuted credentials and a permanent command error stays public", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    await discord(mf, await discordRequest(slash()));
    const store = await storage(mf, "DiscordGuild");
    await store.exec(
      "UPDATE bot_jobs SET data = json_set(data, '$.deadline', ?) WHERE key = '111'",
      Date.now() - 1,
    );
    await terminalJob(store, "111");
    expect(fixtures.calls).toEqual([]);
    fixtures.dataStatus = 403;
    await discord(mf, await discordRequest(slash("sell", "101", "222")));
    await terminalJob(store, "222");
    expect(fixtures.discordReplies()[0]?.body).toEqual({
      content: "Something went wrong while executing your command!",
      allowed_mentions: { parse: [] },
    });
  } finally {
    await mf.dispose();
  }
});

test("an invalid non-ASCII Twitch secret fails configuration without leaking it", async () => {
  const mf = createWorker(new ExternalFixtures(), undefined, {
    ...bindings,
    TWITCH_WEBHOOK_SECRET: "secret-with-é-characters",
  });
  try {
    const response = await discord(
      mf,
      await discordRequest({ type: 1, application_id: "123" }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Invalid ingress configuration");
    expect(body).not.toContain("secret-with-é-characters");
  } finally {
    await mf.dispose();
  }
});

test("acceptance rolls back the job when callback scheduling fails", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  try {
    await discord(mf, await discordRequest(slash()));
    const store = await storage(mf, "DiscordGuild");
    await terminalJob(store, "111");
    await store.exec(
      "CREATE TRIGGER reject_callback BEFORE INSERT ON alchemy_alarm_callbacks BEGIN SELECT RAISE(ABORT, 'fixture scheduling failure'); END",
    );
    const signed = await discordRequest(slash("sell", "101", "222"));
    expect((await discord(mf, signed)).status).toBe(503);
    expect(
      await store.exec("SELECT key FROM bot_jobs WHERE key = '222'"),
    ).toEqual([]);
    expect(
      await store.exec(
        "SELECT id FROM alchemy_alarm_callbacks WHERE id = '222'",
      ),
    ).toEqual([]);
    await store.exec("DROP TRIGGER reject_callback");
    expect((await discord(mf, signed)).status).toBe(200);
    await terminalJob(store, "222");
    expect(fixtures.discordReplies()).toHaveLength(2);
  } finally {
    await mf.dispose();
  }
});

test("terminating a running callback recovers the persisted attempt and reply", async () => {
  const fixtures = new ExternalFixtures();
  const mf = createWorker(fixtures);
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixtures.override = (call) => {
    if (!call.url.startsWith("https://discord.com/")) return undefined;
    entered();
    return new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          new Response(JSON.stringify({ id: "1000" }), {
            headers: { "content-type": "application/json" },
          }),
        );
    });
  };
  try {
    expect((await discord(mf, await discordRequest(slash()))).status).toBe(200);
    await started;
    const store = await storage(mf, "DiscordGuild");
    expect(
      await store.exec(
        "SELECT json_extract(data,'$.kind') AS kind,json_extract(data,'$.attempts') AS attempts FROM bot_jobs",
      ),
    ).toEqual([{ kind: "reply", attempts: 1 }]);
    await mf.unsafeEvictDurableObject("ArcBot", "DiscordGuild", {
      name: "101",
    });
    fixtures.override = undefined;
    release();
    await terminalJob(store, "111");
    expect(fixtures.discordReplies().map((call) => call.body)).toEqual([
      {
        content: "Sensors can be sold for 42 coins each",
        allowed_mentions: { parse: [] },
      },
      {
        content: "Sensors can be sold for 42 coins each",
        allowed_mentions: { parse: [] },
      },
    ]);
    expect(
      fixtures.calls.filter((call) => call.url.includes("metaforge.app")),
    ).toHaveLength(1);
  } finally {
    release();
    await mf.dispose();
  }
}, 45000);

test("Twitch refreshes a rejected app token once and bounds the threaded reply to 500 characters", async () => {
  const fixtures = new ExternalFixtures();
  let sends = 0;
  fixtures.override = (call) => {
    if (call.url !== "https://api.twitch.tv/helix/chat/messages")
      return undefined;
    sends++;
    return sends === 1 ? new Response("", { status: 401 }) : undefined;
  };
  const mf = createWorker(fixtures);
  try {
    await twitch(
      mf,
      await twitchRequest(twitchBody(`!sell ${"x".repeat(600)}`)),
    );
    await terminalJob(await storage(mf, "TwitchChannel"), "delivery-1");
    expect(
      fixtures.calls.filter((call) =>
        call.url.startsWith("https://id.twitch.tv/"),
      ),
    ).toHaveLength(2);
    expect(fixtures.twitchReplies().map((call) => call.body)).toEqual(
      Array.from({ length: 2 }, () => ({
        broadcaster_id: "101",
        sender_id: "999",
        reply_parent_message_id: "chat-message-1",
        message: `[Warn] No such item: ${"x".repeat(479)}`,
      })),
    );
  } finally {
    await mf.dispose();
  }
});

test("Twitch 429 reset headers persist a wake after the rate limit resets", async () => {
  const fixtures = new ExternalFixtures();
  const reset = Math.floor(Date.now() / 1000) + 60;
  fixtures.override = (call) =>
    call.url === "https://api.twitch.tv/helix/chat/messages"
      ? json({ error: "rate limit" }, 429, { "ratelimit-reset": String(reset) })
      : undefined;
  const mf = createWorker(fixtures);
  try {
    expect((await twitch(mf, await twitchRequest(twitchBody()))).status).toBe(
      204,
    );
    const store = await storage(mf, "TwitchChannel");
    await expect
      .poll(
        () =>
          store.exec(
            "SELECT CASE WHEN run_at >= ? AND run_at <= ? THEN 1 ELSE 0 END AS respects_reset FROM alchemy_alarm_callbacks WHERE id = 'delivery-1'",
            reset * 1000,
            reset * 1000 + 5000,
          ),
        { timeout: 5000 },
      )
      .toEqual([{ respects_reset: 1 }]);
    expect(fixtures.twitchReplies().map((call) => call.body)).toEqual([
      {
        broadcaster_id: "101",
        sender_id: "999",
        reply_parent_message_id: "chat-message-1",
        message: "Sensors can be sold for 42 coins each",
      },
    ]);
    expect(
      await store.exec(
        "SELECT json_extract(data, '$.attempts') AS attempts FROM bot_jobs WHERE key = 'delivery-1'",
      ),
    ).toEqual([{ attempts: 1 }]);
  } finally {
    await mf.dispose();
  }
});

test.each([
  { tokenType: "Bearer", sent: true },
  { tokenType: "Basic", sent: false },
])("Twitch token type $tokenType produces sent=$sent", async ({
  tokenType,
  sent,
}) => {
  const fixtures = new ExternalFixtures();
  fixtures.override = (call) =>
    call.url.startsWith("https://id.twitch.tv/")
      ? json({
          access_token: "local-app-token",
          expires_in: 3600,
          token_type: tokenType,
        })
      : undefined;
  const mf = createWorker(fixtures);
  try {
    expect((await twitch(mf, await twitchRequest(twitchBody()))).status).toBe(
      204,
    );
    await terminalJob(await storage(mf, "TwitchChannel"), "delivery-1");
    expect(fixtures.twitchReplies().map((call) => call.body)).toEqual(
      sent
        ? [
            {
              broadcaster_id: "101",
              sender_id: "999",
              reply_parent_message_id: "chat-message-1",
              message: "Sensors can be sold for 42 coins each",
            },
          ]
        : [],
    );
    expect(
      fixtures.calls.filter((call) =>
        call.url.startsWith("https://id.twitch.tv/"),
      ),
    ).toHaveLength(1);
  } finally {
    await mf.dispose();
  }
});

test.each([
  {
    message_id: "",
    is_sent: false,
    drop_reason: { code: "msg_rejected", message: "not allowed" },
  },
  {
    message_id: "sent",
    is_sent: true,
    drop_reason: { code: "msg_rejected", message: "not allowed" },
  },
])("Twitch dropped replies become terminal without outbound retries", async (result) => {
  const fixtures = new ExternalFixtures();
  fixtures.twitchResponse = { data: [result] };
  const mf = createWorker(fixtures);
  try {
    await twitch(mf, await twitchRequest(twitchBody()));
    await terminalJob(await storage(mf, "TwitchChannel"), "delivery-1");
    expect(fixtures.twitchReplies()).toHaveLength(1);
  } finally {
    await mf.dispose();
  }
});

test("an HTTP timeout cannot retain a Discord interaction credential forever", async () => {
  const fixtures = new ExternalFixtures();
  let release = () => {};
  fixtures.override = (call) => {
    if (!call.url.startsWith("https://discord.com/")) return undefined;
    return new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          new Response(JSON.stringify({ id: "1000" }), {
            headers: { "content-type": "application/json" },
          }),
        );
    });
  };
  const mf = createWorker(fixtures);
  try {
    await discord(mf, await discordRequest(slash()));
    const store = await storage(mf, "DiscordGuild");
    await store.exec(
      "UPDATE bot_jobs SET data = json_set(data, '$.attempts', 4)",
    );
    await terminalJob(store, "111");
    expect(fixtures.discordReplies()).toHaveLength(1);
  } finally {
    release();
    await mf.dispose();
  }
});
