import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { discordResponse } from "../../apps/bot/src/presentation.js";
import {
  AccountStatus,
  SetupResult,
} from "../../apps/bot/src/twitch-contracts.js";
import { cloudSettings } from "../../scripts/cloud-settings.js";
import {
  FixtureHttpError,
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
  negativeFutureStamp,
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
  fallback: string | null;
  fallbackCode: string | null;
  tenantPhase: string | null;
  tenantCode: string | null;
  admissionDeltaMs: number | null;
  cutoff: number | null;
  activation: string | null;
}[] = [];
const twitchSamples: {
  scenario: string;
  workerAckMs: number;
  clientAckMs: number;
  observedDeliveryClientMs: number;
}[] = [];
const pendingTwitchSamples = new Map<
  string,
  { start: number; workerAckMs: number; clientAckMs: number }
>();
const recordSamples = () =>
  Effect.promise(() =>
    writeFile(
      new URL(
        `../../.cloud-tests/${settings.stage}/timings.json`,
        import.meta.url,
      ),
      JSON.stringify(samples, null, 2),
    ),
  ).pipe(
    Effect.andThen(
      Effect.promise(() =>
        writeFile(
          new URL(
            `../../.cloud-tests/${settings.stage}/twitch-timings.json`,
            import.meta.url,
          ),
          JSON.stringify(twitchSamples, null, 2),
        ),
      ),
    ),
  );
const rejected = Effect.fnUntraced(function* <A, E>(
  effect: Effect.Effect<A, E>,
  status: number,
) {
  const result = yield* effect.pipe(Effect.result);
  expect(result._tag).toBe("Failure");
  if (
    result._tag !== "Failure" ||
    !(result.failure instanceof FixtureHttpError)
  )
    return yield* Effect.die("Expected a terminal HTTP rejection");
  expect(result.failure.diagnostic.status).toBe(status);
  expect(result.failure.diagnostic.tenant?.lookups).toBe("0");
  expect(result.failure.diagnostic.tenant?.rpcs).toBe("0");
});
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
  beforeAll,
}: Pick<typeof Foundation, "stack" | "test" | "beforeAll">) {
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
    enforceBudget = true,
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
        fallback: response.headers.get("x-arc-command-fallback"),
        fallbackCode: response.headers.get("x-arc-command-code"),
        tenantPhase: response.headers.get("x-arc-tenant-phase"),
        tenantCode: response.headers.get("x-arc-tenant-code"),
        admissionDeltaMs: response.headers.has("x-arc-admission-delta-ms")
          ? Number(response.headers.get("x-arc-admission-delta-ms"))
          : null,
        cutoff: response.headers.has("x-arc-tenant-cutoff")
          ? Number(response.headers.get("x-arc-tenant-cutoff"))
          : null,
        activation: response.headers.get("x-arc-tenant-activation"),
      });
      yield* recordSamples();
      if (enforceBudget) {
        expect(workerMs).toBeGreaterThanOrEqual(0);
        expect(workerMs).toBeLessThan(3000);
        expect(elapsed).toBeLessThan(3000);
      }
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
    const headers = yield* signTwitch(bytes, id, at, type);
    const start = performance.now();
    const response = yield* request(`${bot}/webhooks/twitch`, {
      method: "POST",
      body: bytes,
      headers,
    });
    if (id.startsWith("notification-"))
      pendingTwitchSamples.set(id, {
        start,
        workerAckMs: Number(response.headers.get("x-arc-ingress-ms")),
        clientAckMs: performance.now() - start,
      });
    return response;
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
  const noTenant = (response: Response) => {
    expect(response.headers.get("x-arc-tenant-lookups")).toBe("0");
    expect(response.headers.get("x-arc-tenant-rpcs")).toBe("0");
  };

  const firstCold = beforeAll(
    Effect.gen(function* () {
      const u = yield* urls;
      return yield* signedDiscord(
        u.bot,
        discordCommand(
          "first-cold",
          "sell",
          "initial-cold",
          "first-cold-guild",
        ),
        "first-http-cold-worker-tenant-cache",
        Date.now(),
        false,
      );
    }).pipe(Effect.result),
    { timeout: 90000 },
  );

  test(
    "the first HTTP request to the new Bot completes a useful cold tenant/cache path within the original budget",
    Effect.gen(function* () {
      const result = yield* firstCold;
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success")
        return yield* Effect.die(
          "First Bot HTTP request failed; retained HTTP diagnostic identifies the failure",
        );
      expect(result.success.reply).toEqual(
        discordResponse("Sensors can be sold for 10 coins each"),
      );
      const sample = samples.find(
        (sample) => sample.scenario === "first-http-cold-worker-tenant-cache",
      );
      if (!sample) return yield* Effect.die("First Bot HTTP sample missing");
      expect(sample.workerMs).toBeLessThan(3000);
      expect(sample.clientMs).toBeLessThan(3000);
      const u = yield* urls;
      expect(
        (yield* get(`${u.source}/observations`, Observations))[
          "/items?id=initial-cold&minimal=true"
        ],
      ).toBe(1);
    }),
    { timeout: 90000 },
  );

  test(
    "actual Bot verifies raw signatures, freshness, bounds and Discord context without allocating tenants",
    Effect.gen(function* () {
      const u = yield* urls;
      const ping = encode(
        ' {"application_id":"fixture-discord", "type":1}\r\n',
      );
      const headers = yield* signDiscord(ping);
      const pong = yield* request(`${u.bot}/interactions/discord`, {
        method: "POST",
        headers,
        body: ping,
      });
      noTenant(pong);
      expect(
        yield* json(pong, Schema.Struct({ type: Schema.Literal(1) })),
      ).toEqual({ type: 1 });
      yield* rejected(
        request(`${u.bot}/interactions/discord`, {
          method: "POST",
          headers,
          body: encode({ application_id: "fixture-discord", type: 1 }),
        }),
        401,
      );
      yield* rejected(
        signedDiscord(u.bot, discordCommand("stale"), "", Date.now() - 301000),
        401,
      );
      yield* rejected(
        signedDiscord(
          u.bot,
          discordCommand("future"),
          "",
          negativeFutureStamp(Date.now()),
        ),
        401,
      );
      yield* rejected(signedDiscord(u.bot, "{"), 400);
      const bad = new Uint8Array([255, 0, 13, 10]);
      yield* rejected(
        request(`${u.bot}/interactions/discord`, {
          method: "POST",
          body: bad,
          headers: yield* signDiscord(bad),
        }),
        400,
      );
      yield* rejected(
        request(`${u.bot}/interactions/discord`, {
          method: "POST",
          body: "x".repeat(65537),
        }),
        413,
      );
      for (const extra of [
        { application_id: "other" },
        { context: 1 },
        { member: undefined },
        { guild_id: undefined },
        { authorizing_integration_owners: { "0": "other" } },
        { data: { name: "unknown", type: 1 } },
        { data: { name: "sell", type: 1, options: [] } },
        { data: { name: "sell", type: 2 } },
      ]) {
        const response = (yield* signedDiscord(u.bot, {
          ...discordCommand("wrong"),
          ...extra,
        })).response;
        noTenant(response);
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
      yield* rejected(
        request(`${u.bot}/webhooks/twitch`, {
          method: "POST",
          body: encode(twitchEvent("bad")),
        }),
        401,
      );
      for (const stamp of [
        Date.now() - 601000,
        negativeFutureStamp(Date.now()),
      ])
        yield* rejected(
          signedTwitch(
            u.bot,
            twitchEvent(
              "stale-twitch",
              "!sell sensors",
              `${u.bot}/webhooks/twitch`,
            ),
            "stale-twitch",
            "notification",
            stamp,
          ),
          401,
        );
      for (const value of ["{", { subscription: {} }])
        yield* rejected(signedTwitch(u.bot, value, "invalid-twitch-body"), 400);
      const context = twitchEvent(
        "wrong-context",
        "!sell sensors",
        `${u.bot}/webhooks/twitch`,
      );
      yield* rejected(
        signedTwitch(
          u.bot,
          {
            ...context,
            subscription: { ...context.subscription, version: "2" },
          },
          "invalid-twitch-context",
        ),
        400,
      );
      const valid = discordCommand(
        "allocation-positive",
        "sell",
        "initial-cold",
        "allocation-guild",
      );
      const positive = yield* signedDiscord(
        u.bot,
        valid,
        "allocation-positive",
      );
      expect(positive.reply).toEqual(
        discordResponse("Sensors can be sold for 10 coins each"),
      );
      expect(positive.response.headers.get("x-arc-tenant-lookups")).toBe("1");
      expect(positive.response.headers.get("x-arc-tenant-rpcs")).toBe("1");
      expect(positive.response.headers.get("x-arc-tenant-phase")).toBe(
        "committed",
      );
      expect(positive.response.headers.get("x-arc-tenant-code")).toBe(
        "success",
      );
      const duplicate = yield* signedDiscord(
        u.bot,
        valid,
        "allocation-stored-duplicate",
      );
      expect(duplicate.reply).toEqual(positive.reply);
      expect(duplicate.response.headers.get("x-arc-tenant-phase")).toBe(
        "committed",
      );
      expect(duplicate.response.headers.get("x-arc-tenant-code")).toBe(
        "recorded",
      );
      expect(
        (yield* get(`${u.source}/observations`, Observations))[
          "/items?id=initial-cold&minimal=true"
        ],
      ).toBe(1);
    }),
    { timeout: 90000 },
  );

  test(
    "actual Bot cold and warm Discord responses use the shared production cache with measured full-path headroom",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* sourceControl(u.source, "/items?id=sensors&minimal=true", {
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
      expect(loaded["/items?id=sensors&minimal=true"]).toBe(
        (before["/items?id=sensors&minimal=true"] ?? 0) + 1,
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
      expect(cached["/items?id=sensors&minimal=true"]).toBe(
        loaded["/items?id=sensors&minimal=true"],
      );
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
      for (const text of ["hello", "!unknown sensors", "ARC: !sell sensors"]) {
        const event = twitchEvent(text, text, `${u.bot}/webhooks/twitch`);
        event.subscription.id = remote.id;
        const ignored = yield* signedTwitch(u.bot, event, text);
        expect(ignored.status).toBe(204);
        noTenant(ignored);
      }
      expect((yield* status(u.bot)).setup).toBe("ready");
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
        const afterDiscord = yield* get(
          `${u.source}/observations`,
          Observations,
        );
        const receivedAt = Date.now();
        const admitted = yield* signedTwitch(
          u.bot,
          event,
          `notification-${command}`,
        );
        expect(admitted.status).toBe(204);
        expect(admitted.headers.get("x-arc-tenant-lookups")).toBe("1");
        expect(admitted.headers.get("x-arc-tenant-rpcs")).toBe("1");
        const sent = (yield* waitMessages(
          u.provider,
          `all-${command}`,
        )).messages.find(
          (message) =>
            message.body.reply_parent_message_id === `all-${command}`,
        );
        expect(sent?.body.message).toBe(text);
        expect(sent?.at).toBeLessThan(receivedAt + 10000);
        const timing = pendingTwitchSamples.get(`notification-${command}`);
        if (!timing) return yield* Effect.die("Missing Twitch timing");
        twitchSamples.push({
          scenario: command,
          workerAckMs: timing.workerAckMs,
          clientAckMs: timing.clientAckMs,
          observedDeliveryClientMs: performance.now() - timing.start,
        });
        yield* recordSamples();
        expect(yield* get(`${u.source}/observations`, Observations)).toEqual(
          afterDiscord,
        );
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
          `/items?id=${name}&minimal=true`,
          body,
          delayMs,
          statusCode,
        );
        const before = yield* get(`${u.source}/observations`, Observations);
        const reply = (yield* signedDiscord(
          u.bot,
          discordCommand(name, "sell", name, `${name}-guild`),
          name,
        )).reply;
        const after = yield* get(`${u.source}/observations`, Observations);
        expect(after[`/items?id=${name}&minimal=true`]).toBe(
          (before[`/items?id=${name}&minimal=true`] ?? 0) + 1,
        );
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
        "/items?id=concurrent&minimal=true",
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
          "/items?id=concurrent&minimal=true"
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
      expect(
        (yield* provider(u.provider)).messages.find(
          (message) => message.body.reply_parent_message_id === "native-alarm",
        )?.body.message,
      ).toBe("Sensors can be sold for 10 coins each");
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
      expect(completed.lostAccountResponseAt).toBeNumber();
      expect(
        (yield* provider(u.provider)).messages.filter(
          (message) => message.body.reply_parent_message_id === "lost-rpc",
        ),
      ).toHaveLength(1);
      expect(
        (yield* provider(u.provider)).messages.find(
          (message) => message.body.reply_parent_message_id === "lost-rpc",
        )?.body.message,
      ).toBe("Sensors can be sold for 10 coins each");
      expect(completed.alarm).toBeNull();
    }),
    { timeout: 90000 },
  );

  test(
    "native recovery joins a live slow account POST and completes its multipart plan",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "slow-account-send";
      yield* sourceControl(u.source, "/items?id=slowparts&minimal=true", {
        data: [{ id: "slowparts", name: "x".repeat(650), value: 10 }],
      });
      yield* post(`${u.provider}/control`, { holdSend: true });
      yield* Effect.gen(function* () {
        yield* post(`${u.tenant}/control`, {
          key,
          control: { immediate: true },
        });
        const input = {
          ...receipt(key),
          invocation: { command: "sell", input: "slowparts" },
        };
        expect(
          (yield* post(`${u.tenant}/accept`, { key, receipt: input })).status,
        ).toBe(204);
        const first = yield* waitMessages(u.provider, key);
        expect(
          first.messages.filter(
            (message) => message.body.reply_parent_message_id === key,
          ),
        ).toHaveLength(1);
        const sending = yield* snapshot(u.tenant, key);
        const work = sending.state?.works[key];
        if (work?.kind !== "delivering")
          return yield* Effect.die("Expected a live delivering claim");
        const alarm = yield* snapshot(u.tenant, key).pipe(
          Effect.repeat({
            until: (value) =>
              value.alarmRuns > 0 && Date.now() >= work.claim.until,
            times: 25,
            schedule: Schedule.spaced(75),
          }),
        );
        expect(alarm.alarmRuns).toBeGreaterThan(0);
        expect(alarm.state?.works[key]?.kind).toBe("delivering");
        yield* post(`${u.provider}/control`, { holdSend: false });
        const terminal = yield* snapshot(u.tenant, key).pipe(
          Effect.repeat({
            until: (value) => value.state?.works[key]?.kind === "terminal",
            times: 30,
            schedule: Schedule.spaced(100),
          }),
        );
        expect(terminal.state?.works[key]).toMatchObject({
          kind: "terminal",
          outcome: "sent",
          deadline: input.receivedAt + 10000,
        });
        expect(terminal.alarm).toBeNull();
        expect(
          (yield* provider(u.provider)).messages.filter(
            (message) => message.body.reply_parent_message_id === key,
          ),
        ).toHaveLength(2);
      }).pipe(
        Effect.ensuring(
          post(`${u.provider}/control`, { holdSend: false }).pipe(Effect.orDie),
        ),
      );
    }),
    { timeout: 90000 },
  );

  test(
    "native Discord interruption commits one private response at the original deadline without a late message",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "discord-interrupted";
      yield* sourceControl(
        u.source,
        "/items?id=interrupt&minimal=true",
        { data: [{ id: "interrupt", name: "Interrupted", value: 10 }] },
        1500,
      );
      const input = {
        id: "interrupt",
        guildId: "native-guild",
        fingerprint: "a".repeat(64),
        receivedAt: Date.now(),
        invocation: { command: "sell", input: "interrupt" },
        token: "CANARY-INTERACTION-TOKEN",
      };
      const original = yield* post(`${u.tenant}/discord`, {
        key,
        receipt: input,
      }).pipe(Effect.result, Effect.forkChild);
      const admitted = yield* snapshot(u.tenant, key).pipe(
        Effect.repeat({
          until: (value) => value.state?.works.interrupt?.kind === "computing",
          times: 20,
          schedule: Schedule.spaced(25),
        }),
      );
      expect(admitted.state?.works.interrupt?.kind).toBe("computing");
      expect((yield* post(`${u.tenant}/reconstruct`, { key })).status).toBe(
        204,
      );
      const rebuilt = yield* reconstructedSnapshot(
        snapshot(u.tenant, key),
        admitted.instance,
      );
      expect(rebuilt.instance).not.toBe(admitted.instance);
      const reply = yield* post(`${u.tenant}/discord`, {
        key,
        receipt: { ...input, receivedAt: Date.now() },
      }).pipe(
        Effect.flatMap((response) =>
          json(
            response,
            Schema.Struct({
              type: Schema.Literal(4),
              data: Schema.Struct({
                flags: Schema.Literal(64),
                content: Schema.String,
              }),
            }),
          ),
        ),
      );
      expect(reply.data.content).toBe(
        "I couldn't finish that command in time. Please try again.",
      );
      const terminal = yield* snapshot(u.tenant, key);
      expect(terminal.state?.works.interrupt).toMatchObject({
        kind: "terminal",
        deadline: input.receivedAt + 3000,
      });
      expect(terminal.alarm).toBeNull();
      expect(JSON.stringify(terminal.state)).not.toContain("CANARY");
      expect(JSON.stringify(terminal.state)).not.toContain("invocation");
      const interrupted = yield* Fiber.join(original);
      if (interrupted._tag === "Failure") {
        expect(interrupted.failure instanceof FixtureHttpError).toBeTrue();
        if (interrupted.failure instanceof FixtureHttpError)
          expect(interrupted.failure.diagnostic.status).toBe(500);
      } else
        expect(
          yield* json(
            interrupted.success,
            Schema.Struct({
              data: Schema.Struct({ flags: Schema.Literal(64) }),
            }),
          ),
        ).toMatchObject({ data: { flags: 64 } });
    }),
    { timeout: 90000 },
  );

  test(
    "actual account ambiguity stops the remaining Twitch parts and replay starts no second POST",
    Effect.gen(function* () {
      const u = yield* urls;
      yield* sourceControl(u.source, "/items?id=long&minimal=true", {
        data: [{ id: "long", name: "x".repeat(1200), value: 10 }],
      });
      yield* post(`${u.provider}/control`, {
        sendStatus: 200,
        sendBody: { data: [{ is_sent: "invalid", message_id: "" }] },
      });
      const remote = (yield* provider(u.provider)).remote.find(
        (entry) => entry.transport.callback === `${u.bot}/webhooks/twitch`,
      );
      if (!remote) return yield* Effect.die("Subscription missing");
      const event = twitchEvent(
        "ambiguous-parts",
        "!sell long",
        `${u.bot}/webhooks/twitch`,
      );
      event.subscription.id = remote.id;
      const started = Date.now();
      expect(
        (yield* signedTwitch(u.bot, event, "ambiguous-parts")).status,
      ).toBe(204);
      const sent = yield* waitMessages(u.provider, "ambiguous-parts");
      expect(
        sent.messages.filter(
          (message) =>
            message.body.reply_parent_message_id === "ambiguous-parts",
        ),
      ).toHaveLength(1);
      expect(
        sent.messages
          .find(
            (message) =>
              message.body.reply_parent_message_id === "ambiguous-parts",
          )
          ?.body.message.startsWith("[1/3]: "),
      ).toBeTrue();
      expect(
        (yield* signedTwitch(u.bot, event, "ambiguous-replay")).status,
      ).toBe(204);
      yield* Effect.sleep(Math.max(0, started + 10500 - Date.now()));
      expect(
        (yield* provider(u.provider)).messages.filter(
          (message) =>
            message.body.reply_parent_message_id === "ambiguous-parts",
        ),
      ).toHaveLength(1);
      yield* post(`${u.provider}/control`, {
        sendBody: { data: [{ is_sent: true, message_id: "restored" }] },
      });
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
      yield* recordSamples();
    }),
    { timeout: 90000 },
  );
  test(
    "timing coverage contains every useful command and intended error category",
    Effect.gen(function* () {
      for (const command of [
        "buy",
        "loot",
        "craft",
        "find",
        "sell",
        "recycle",
        "recycleto",
        "event",
        "active",
        "upcoming",
      ]) {
        const observed = samples.filter(
          (sample) => sample.scenario === `command-${command}`,
        );
        expect(observed).toHaveLength(1);
        expect(observed[0]?.flags).toBe(0);
        expect(observed[0]?.fallback).toBeNull();
        expect(observed[0]?.tenantPhase).toBe("committed");
      }
      const warm = samples.filter(
        (sample) => sample.scenario === "warm-cache-warm-tenant",
      );
      expect(warm).toHaveLength(3);
      for (const sample of warm) {
        expect(sample.flags).toBe(0);
        expect(sample.fallback).toBeNull();
      }
      for (const scenario of ["slow", "missing", "malformed"]) {
        const observed = samples.filter(
          (sample) => sample.scenario === scenario,
        );
        expect(observed).toHaveLength(1);
        expect(observed[0]?.flags).toBe(64);
        expect(observed[0]?.fallback).toBeNull();
        expect(observed[0]?.tenantCode).toBe("command-error");
      }
      expect(samples).toHaveLength(22);
      expect(twitchSamples).toHaveLength(10);
      yield* recordSamples();
    }),
    { timeout: 90000 },
  );
}
