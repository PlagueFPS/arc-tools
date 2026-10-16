import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import { Effect, Fiber, Schedule, Schema, Stream } from "effect";
import Stack from "../../alchemy.run.js";
import { discordResponse } from "../../apps/bot/src/presentation.js";
import {
  AccountStatus,
  SetupResult,
} from "../../apps/bot/src/twitch-contracts.js";
import { cloudSettings } from "../../scripts/cloud-settings.js";
import {
  get,
  json,
  post,
  reconstructedSnapshot,
  request,
} from "./fixture-http.js";
import type * as Foundation from "./foundation.test.js";
import { Observations } from "./metaforge.js";
import {
  discordCommand,
  signDiscord,
  signTwitch,
  twitchEvent,
} from "./signatures.js";
import { TenantSnapshot } from "./tenant-fixture.js";
import { ProviderSnapshot } from "./twitch-provider-fixture.js";

const settings = cloudSettings(process.env);
const encode = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
const samples: {
  scenario: string;
  workerMs: number;
  clientMs: number;
  status: number;
  flags: number;
  content: string;
}[] = [];
const recordSamples = () =>
  Effect.promise(() =>
    writeFile(
      new URL(
        `../../.cloud-tests/${settings.stage}/timings.json`,
        import.meta.url,
      ),
      JSON.stringify(samples, null, 2),
    ),
  );
const snapshot = (url: string, key: string) =>
  get(`${url}/snapshot?key=${key}`, TenantSnapshot);
const provider = (url: string) => get(`${url}/snapshot`, ProviderSnapshot);
const waitMessages = (url: string, parent: string) =>
  provider(url).pipe(
    Effect.repeat({
      until: (value) =>
        value.messages.some(
          (message) => message.body.reply_parent_message_id === parent,
        ),
      times: 40,
      schedule: Schedule.spaced(250),
    }),
  );
const sourceControl = (
  url: string,
  key: string,
  body: unknown,
  delayMs = 0,
  status = 200,
) => post(`${url}/control`, { key, body, delayMs, status });
const receipt = (id: string, receivedAt = Date.now()) => ({
  id,
  receivedAt,
  fingerprint: "a".repeat(64),
  broadcasterId: "200",
  replyParentId: id,
  invocation: { command: "sell", input: "sensors" },
});

export function registerTenantTests({
  stack,
  test,
}: Pick<typeof Foundation, "stack" | "test">) {
  const urls = Effect.gen(function* () {
    const deployed = yield* stack;
    if (!deployed.tenantUrl || !deployed.sourceUrl || !deployed.providerUrl)
      return yield* Effect.die("Missing tenant fixture URLs");
    return {
      bot: deployed.url,
      tenant: deployed.tenantUrl,
      source: deployed.sourceUrl,
      provider: deployed.providerUrl,
      workerName: deployed.workerName,
    };
  });
  const signedDiscord = Effect.fnUntraced(function* (
    bot: string,
    value: unknown,
    scenario = "",
    at = Date.now(),
  ) {
    const bytes = encode(value);
    const headers = yield* signDiscord(bytes, at);
    const start = performance.now();
    const response = yield* request(`${bot}/interactions/discord`, {
      method: "POST",
      headers,
      body: bytes,
    });
    if (scenario) {
      const reply = yield* json(
        response,
        Schema.Struct({
          type: Schema.Literal(4),
          data: Schema.Struct({
            content: Schema.String,
            flags: Schema.Number,
            allowed_mentions: Schema.Struct({
              parse: Schema.Array(Schema.Never),
              replied_user: Schema.Literal(false),
            }),
          }),
        }),
      );
      const elapsed = performance.now() - start;
      const stamp = response.headers.get("x-arc-ingress-ms");
      if (!stamp || !/^\d+$/.test(stamp))
        return yield* Effect.die("Missing ingress timing stamp");
      const workerMs = Number(stamp);
      samples.push({
        scenario,
        workerMs,
        clientMs: elapsed,
        status: response.status,
        flags: reply.data.flags,
        content: reply.data.content,
      });
      yield* recordSamples();
      expect(workerMs).toBeGreaterThanOrEqual(0);
      expect(workerMs).toBeLessThan(3000);
      expect(elapsed).toBeLessThan(3000);
      return { response, reply };
    }
    return { response, reply: null };
  });
  const signedTwitch = Effect.fnUntraced(function* (
    bot: string,
    event: unknown,
    id: string,
    type = "notification",
    at = Date.now(),
  ) {
    const bytes = encode(event);
    return yield* request(`${bot}/webhooks/twitch`, {
      method: "POST",
      body: bytes,
      headers: yield* signTwitch(bytes, id, at, type),
    });
  });
  const setup = Effect.fnUntraced(function* (bot: string) {
    return yield* request(`${bot}/ops/setup`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-operator",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stage: settings.stage }),
    }).pipe(Effect.flatMap((response) => json(response, SetupResult)));
  });
  const status = Effect.fnUntraced(function* (bot: string) {
    return yield* request(`${bot}/ops/status`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-operator",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stage: settings.stage }),
    }).pipe(Effect.flatMap((response) => json(response, AccountStatus)));
  });
  const tenantObjects = Effect.fnUntraced(function* (workerName: string) {
    return yield* Core.withProviders(
      Effect.gen(function* () {
        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
        const namespaces = yield* DurableObjects.listNamespaces
          .items({ accountId })
          .pipe(Stream.runCollect);
        const namespace = namespaces.find(
          (namespace) =>
            namespace.script === workerName && namespace.class === "Tenant",
        );
        if (!namespace?.id)
          return yield* Effect.die("Actual Bot tenant namespace missing");
        return yield* DurableObjects.listNamespaceObjects
          .items({ accountId, id: namespace.id })
          .pipe(Stream.runCollect);
      }),
      {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
        stage: settings.stage,
        profile: settings.profile,
      },
      Stack.stackName,
    );
  });

  test(
    "actual Bot verifies raw signatures, freshness, bounds and Discord context without allocating tenants",
    Effect.gen(function* () {
      const u = yield* urls;
      expect(yield* tenantObjects(u.workerName)).toEqual([]);
      const ping = encode(
        ' {"application_id":"fixture-discord", "type":1}\r\n',
      );
      const headers = yield* signDiscord(ping);
      const pong = yield* request(`${u.bot}/interactions/discord`, {
        method: "POST",
        headers,
        body: ping,
      });
      expect(
        yield* json(pong, Schema.Struct({ type: Schema.Literal(1) })),
      ).toEqual({ type: 1 });
      expect(
        (yield* request(`${u.bot}/interactions/discord`, {
          method: "POST",
          headers,
          body: encode({ application_id: "fixture-discord", type: 1 }),
        })).status,
      ).toBe(401);
      expect(
        (yield* signedDiscord(
          u.bot,
          discordCommand("stale"),
          "",
          Date.now() - 301000,
        )).response.status,
      ).toBe(401);
      expect(
        (yield* signedDiscord(
          u.bot,
          discordCommand("future"),
          "",
          Date.now() + 31000,
        )).response.status,
      ).toBe(401);
      expect((yield* signedDiscord(u.bot, "{")).response.status).toBe(400);
      const bad = new Uint8Array([255, 0, 13, 10]);
      expect(
        (yield* request(`${u.bot}/interactions/discord`, {
          method: "POST",
          body: bad,
          headers: yield* signDiscord(bad),
        })).status,
      ).toBe(400);
      expect(
        (yield* request(`${u.bot}/interactions/discord`, {
          method: "POST",
          body: "x".repeat(65537),
        })).status,
      ).toBe(413);
      for (const extra of [
        { application_id: "other" },
        { context: 1 },
        { member: undefined },
        { guild_id: undefined },
        { authorizing_integration_owners: { "0": "other" } },
      ]) {
        const response = (yield* signedDiscord(u.bot, {
          ...discordCommand("wrong"),
          ...extra,
        })).response;
        expect(
          yield* json(
            response,
            Schema.Struct({
              type: Schema.Literal(4),
              data: Schema.Struct({ flags: Schema.Literal(64) }),
            }),
          ),
        ).toMatchObject({ type: 4, data: { flags: 64 } });
      }
      expect(
        (yield* request(`${u.bot}/webhooks/twitch`, {
          method: "POST",
          body: encode(twitchEvent("bad")),
        })).status,
      ).toBe(401);
      expect(yield* tenantObjects(u.workerName)).toEqual([]);
    }),
    { timeout: 90000 },
  );

  test(
    "actual Bot cold and warm Discord responses use the shared production cache with measured full-path headroom",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* sourceControl(u.source, "/items?id=sensors", {
        data: [
          {
            id: "sensors",
            name: "Sensors",
            value: 10,
            loot_area: "Industrial",
            recycle_components: [],
            recycle_from: [],
          },
        ],
      });
      const before = yield* get(`${u.source}/observations`, Observations);
      const cold = yield* signedDiscord(
        u.bot,
        discordCommand("cold", "sell", "sensors", "cold-guild"),
        "cold-cache-cold-tenant",
      );
      expect(cold.reply).toEqual(
        discordResponse("Sensors can be sold for 10 coins each"),
      );
      const loaded = yield* get(`${u.source}/observations`, Observations);
      expect(loaded["/items?id=sensors"]).toBe(
        (before["/items?id=sensors"] ?? 0) + 1,
      );
      for (let n = 0; n < 3; n++)
        expect(
          (yield* signedDiscord(
            u.bot,
            discordCommand(`warm-${n}`, "sell", "sensors", "cold-guild"),
            "warm-cache-warm-tenant",
          )).reply,
        ).toEqual(discordResponse("Sensors can be sold for 10 coins each"));
      const cached = yield* get(`${u.source}/observations`, Observations);
      expect(cached["/items?id=sensors"]).toBe(loaded["/items?id=sensors"]);
    }),
    { timeout: 90000 },
  );

  test(
    "actual Bot account sees its origin, signed challenge stays pending and ordinary personal chat allocates no channel tenant",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* post(`${u.provider}/control`, {
        holdSend: false,
        holdCreate: false,
        holdMint: false,
        remote: [],
        createStatus: "webhook_callback_verification_pending",
        resetMessages: true,
        sendStatus: 200,
        sendBody: {
          data: [{ is_sent: true, message_id: "actual-bot-message" }],
        },
      });
      const first = yield* setup(u.bot);
      expect(first.authorizations.length).toBeGreaterThan(0);
      for (const authorization of first.authorizations) {
        const params = new URL(authorization.url).searchParams;
        expect(params.get("redirect_uri")).toBe(
          `${u.bot}/oauth/twitch/callback`,
        );
        const callback = new URL(`${u.bot}/oauth/twitch/callback`);
        callback.searchParams.set("state", params.get("state") ?? "");
        callback.searchParams.set(
          "code",
          JSON.stringify({
            userId: authorization.login === "fixture_sender" ? "100" : "200",
            login: authorization.login,
            scopes: params.get("scope")?.split(" "),
            clientId: "fixture-twitch",
          }),
        );
        expect((yield* request(callback.toString())).status).toBe(200);
      }
      const pending = yield* setup(u.bot);
      expect(pending.status.setup).toBe("pending");
      const remote = (yield* provider(u.provider)).remote.find(
        (entry) => entry.transport.callback === `${u.bot}/webhooks/twitch`,
      );
      if (!remote) return yield* Effect.die("Actual Bot subscription missing");
      const challenge = {
        subscription: {
          ...remote,
          status: "webhook_callback_verification_pending",
        },
        challenge: "exact-challenge-👋",
      };
      const challenged = yield* signedTwitch(
        u.bot,
        challenge,
        "challenge",
        "webhook_callback_verification",
      );
      expect(challenged.status).toBe(200);
      expect(yield* Effect.promise(() => challenged.text())).toBe(
        "exact-challenge-👋",
      );
      expect((yield* status(u.bot)).setup).toBe("pending");
      const objectsBefore = yield* tenantObjects(u.workerName);
      for (const text of ["hello", "!unknown sensors", "ARC: !sell sensors"]) {
        const event = twitchEvent(text, text, `${u.bot}/webhooks/twitch`);
        event.subscription.id = remote.id;
        expect((yield* signedTwitch(u.bot, event, text)).status).toBe(204);
      }
      expect((yield* status(u.bot)).setup).toBe("ready");
      expect(yield* tenantObjects(u.workerName)).toEqual(objectsBefore);
      expect((yield* provider(u.provider)).messages).toEqual([]);
    }),
    { timeout: 90000 },
  );

  test(
    "all ten commands execute through actual Bot routes, cache and accepted account dispatch on both transports",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* sourceControl(u.source, "/traders", {
        data: {
          Apollo: [],
          Celeste: [],
          Lance: [],
          Shani: [{ id: "sensors", name: "Sensors", trader_price: 100 }],
          TianWen: [],
        },
      });
      yield* sourceControl(u.source, "/arcs?id=bastion&includeLoot=true", {
        data: [
          {
            id: "bastion",
            name: "Bastion",
            loot: [{ item: { id: "sensors", name: "Sensors" } }],
          },
        ],
      });
      yield* sourceControl(
        u.source,
        "/items?id=sensors&includeComponents=true",
        {
          data: [
            {
              id: "sensors",
              name: "Sensors",
              value: 10,
              loot_area: "Industrial",
              recycle_components: [],
              recycle_from: [],
            },
          ],
        },
      );
      const now = Date.now();
      yield* sourceControl(u.source, "/events-schedule", {
        data: [
          {
            name: "Harvester",
            map: "Dam",
            startTime: now - 30000,
            endTime: now + 90000,
          },
          {
            name: "Harvester",
            map: "Spaceport",
            startTime: now + 90000,
            endTime: now + 210000,
          },
        ],
      });
      const cases = [
        ["buy", "sensors", "Sensors can be purchased from Shani for 100 cred."],
        ["loot", "bastion", "Bastions drop the following items: Sensors"],
        ["craft", "sensors", "Sensors cannot be crafted."],
        ["find", "sensors", "Sensors can be found in Industrial areas."],
        ["sell", "sensors", "Sensors can be sold for 10 coins each"],
        ["recycle", "sensors", "No items granted for recycling Sensors"],
        ["recycleto", "sensors", "No items recycle to Sensors"],
        ["event", "queen", "Harvester on Dam is active now (ends in 1m)"],
        ["active", "", "Harvester on Dam (ends in 1m)"],
        ["upcoming", "", "Harvester on Spaceport (starts in 1m)"],
      ] as const;
      const remote = (yield* provider(u.provider)).remote.find(
        (entry) => entry.transport.callback === `${u.bot}/webhooks/twitch`,
      );
      if (!remote) return yield* Effect.die("Subscription missing");
      for (const [command, input, text] of cases) {
        expect(
          (yield* signedDiscord(
            u.bot,
            discordCommand(`all-${command}`, command, input),
            `command-${command}`,
          )).reply,
        ).toEqual(discordResponse(text));
        const event = twitchEvent(
          `all-${command}`,
          `!${command} ${input}`,
          `${u.bot}/webhooks/twitch`,
        );
        event.subscription.id = remote.id;
        const receivedAt = Date.now();
        expect(
          (yield* signedTwitch(u.bot, event, `notification-${command}`)).status,
        ).toBe(204);
        const sent = (yield* waitMessages(
          u.provider,
          `all-${command}`,
        )).messages.find(
          (message) =>
            message.body.reply_parent_message_id === `all-${command}`,
        );
        expect(sent?.body.message).toBe(`ARC: ${text}`);
        expect(sent?.at).toBeLessThan(receivedAt + 10000);
        expect(
          (yield* signedTwitch(u.bot, event, `retry-${command}`)).status,
        ).toBe(204);
        expect(
          (yield* provider(u.provider)).messages.filter(
            (message) =>
              message.body.reply_parent_message_id === `all-${command}`,
          ),
        ).toHaveLength(1);
      }
      const generated =
        (yield* provider(u.provider)).messages[0]?.body.message ?? "";
      const echo = twitchEvent(
        "generated",
        generated,
        `${u.bot}/webhooks/twitch`,
      );
      echo.subscription.id = remote.id;
      expect((yield* signedTwitch(u.bot, echo, "echo")).status).toBe(204);
      expect((yield* provider(u.provider)).messages).toHaveLength(10);
    }),
    { timeout: 90000 },
  );

  test(
    "slow, missing and malformed data return private initial responses with measured headroom and no late reply",
    Effect.gen(function* () {
      const u = yield* urls;
      for (const [name, body, delayMs, statusCode] of [
        [
          "slow",
          { data: [{ id: "slow", name: "Slow", value: 10 }] },
          2500,
          200,
        ],
        ["missing", {}, 0, 503],
        ["malformed", { data: [{ id: "malformed", name: 10 }] }, 0, 200],
      ] as const) {
        yield* sourceControl(
          u.source,
          `/items?id=${name}`,
          body,
          delayMs,
          statusCode,
        );
        const reply = (yield* signedDiscord(
          u.bot,
          discordCommand(name, "sell", name, `${name}-guild`),
          name,
        )).reply;
        expect(reply?.data.flags).toBe(64);
        expect(reply?.data.content).toBe(
          "Game data is temporarily unavailable. Please try again shortly.",
        );
      }
      const observed = yield* provider(u.provider);
      expect(
        observed.logs.some((entry) => /interaction|webhook/.test(entry)),
      ).toBeFalse();
      expect(JSON.stringify(observed.logs)).not.toContain(
        "CANARY-INTERACTION-TOKEN",
      );
    }),
    { timeout: 90000 },
  );

  test(
    "concurrent signed Discord duplicates retain the original healthy computation beyond 500ms",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* sourceControl(
        u.source,
        "/items?id=concurrent",
        { data: [{ id: "concurrent", name: "Concurrent", value: 11 }] },
        1100,
      );
      const invocation = discordCommand(
        "concurrent",
        "sell",
        "concurrent",
        "duplicate-guild",
      );
      const first = yield* signedDiscord(
        u.bot,
        invocation,
        "concurrent-original",
      ).pipe(Effect.forkChild);
      yield* Effect.sleep(100);
      const second = yield* signedDiscord(
        u.bot,
        invocation,
        "concurrent-duplicate",
      ).pipe(Effect.forkChild);
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      expect(a.reply).toEqual(
        discordResponse("Concurrent can be sold for 11 coins each"),
      );
      expect(b.reply).toEqual(a.reply);
      expect(
        (yield* get(`${u.source}/observations`, Observations))[
          "/items?id=concurrent"
        ],
      ).toBe(1);
    }),
    { timeout: 90000 },
  );

  test(
    "native Tenant admission persists a useful alarm before acknowledgement and reconstructs into one delivery",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "native-alarm";
      const input = receipt("native-alarm");
      expect(
        (yield* post(`${u.tenant}/accept`, { key, receipt: input })).status,
      ).toBe(204);
      const admitted = yield* snapshot(u.tenant, key);
      expect(admitted.state?.works["native-alarm"]).toMatchObject({
        kind: "computing",
        receivedAt: input.receivedAt,
        deadline: input.receivedAt + 10000,
      });
      expect(admitted.alarm).toBeLessThan(input.receivedAt + 10000);
      expect((yield* post(`${u.tenant}/reconstruct`, { key })).status).toBe(
        204,
      );
      const rebuilt = yield* reconstructedSnapshot(
        snapshot(u.tenant, key),
        admitted.instance,
      );
      expect(rebuilt.state).toEqual(admitted.state);
      expect(rebuilt.alarm).toBe(admitted.alarm);
      const completed = yield* snapshot(u.tenant, key).pipe(
        Effect.repeat({
          until: (value) =>
            value.state?.works["native-alarm"]?.kind === "terminal",
          times: 40,
          schedule: Schedule.spaced(250),
        }),
      );
      expect(completed.state?.works["native-alarm"]).toMatchObject({
        kind: "terminal",
        outcome: "sent",
      });
      expect(completed.alarmRuns).toBeGreaterThan(0);
      expect(completed.alarm).toBeNull();
      expect(JSON.stringify(completed.state)).not.toContain("parent");
      expect(
        (yield* provider(u.provider)).messages.filter(
          (message) => message.body.reply_parent_message_id === "native-alarm",
        ),
      ).toHaveLength(1);
    }),
    { timeout: 90000 },
  );

  test(
    "lost tenant account completion reuses the persisted dispatch without a second external POST",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "lost-rpc";
      yield* post(`${u.tenant}/control`, {
        key,
        control: { immediate: true, loseAccountResponse: true },
      });
      const input = receipt("lost-rpc");
      expect(
        (yield* post(`${u.tenant}/accept`, { key, receipt: input })).status,
      ).toBe(204);
      const completed = yield* snapshot(u.tenant, key).pipe(
        Effect.repeat({
          until: (value) => value.state?.works["lost-rpc"]?.kind === "terminal",
          times: 40,
          schedule: Schedule.spaced(250),
        }),
      );
      expect(completed.state?.works["lost-rpc"]).toMatchObject({
        kind: "terminal",
        outcome: "sent",
        deadline: input.receivedAt + 10000,
      });
      expect(
        (yield* provider(u.provider)).messages.filter(
          (message) => message.body.reply_parent_message_id === "lost-rpc",
        ),
      ).toHaveLength(1);
      expect(completed.alarm).toBeNull();
    }),
    { timeout: 90000 },
  );

  test(
    "verified revocation is durable before acknowledgement and blocks the actual account",
    Effect.gen(function* () {
      const u = yield* urls;
      const remote = (yield* provider(u.provider)).remote.find(
        (entry) => entry.transport.callback === `${u.bot}/webhooks/twitch`,
      );
      if (!remote) return yield* Effect.die("Subscription missing");
      expect(
        (yield* signedTwitch(
          u.bot,
          { subscription: { ...remote, status: "authorization_revoked" } },
          "revoke",
          "revocation",
        )).status,
      ).toBe(204);
      const revoked = yield* status(u.bot);
      expect(revoked.channels[0]?.authorized).toBeFalse();
      expect(revoked.sender?.authorized).toBeFalse();
      expect(samples.length).toBeGreaterThanOrEqual(19);
      yield* recordSamples();
    }),
    { timeout: 90000 },
  );
}
