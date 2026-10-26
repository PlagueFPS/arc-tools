import { expect } from "bun:test";

import {
  AccountStatus,
  SetupResult,
  SubscriptionAdmission,
  subscriptionBinding,
} from "@arctools/twitch/server";
import {
  Predicate,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Schema,
  Redacted,
} from "effect";

import { discordResponse } from "../../apps/bot/src/presentation.js";
import { cloudSettings } from "../../scripts/cloud-settings.js";
import { expectDataFailure } from "./discord-failure.js";
import { retainJourney } from "./fixture-evidence.js";
import {
  auditedObservation,
  observe,
  FixtureRequestError,
  get,
  json,
  post,
  reconstructedSnapshot,
  responseMetadata,
  request,
} from "./fixture-http.js";
import { withProviderControl, withSourceHold } from "./fixture-journey.js";
import { journeyUrl } from "./fixture-routing.js";
import {
  immutableWork,
  hasUsefulNativeSchedule,
  ingressTiming,
} from "./fixture-timing.js";
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

const encode = (value: Schema.Json) =>
  new TextEncoder().encode(
    Schema.is(Schema.String)(value) ? value : JSON.stringify(value),
  );

const rejected = Effect.fnUntraced(function* <A, E>(
  effect: Effect.Effect<A, E>,
  status: number,
) {
  const result = yield* effect.pipe(Effect.result);
  expect(result._tag).toBe("Failure");

  if (
    !Predicate.isTagged(result, "Failure") ||
    !Schema.is(FixtureRequestError)(result.failure)
  )
    return yield* Effect.die("Expected a terminal HTTP rejection");

  if (result.failure.diagnostic.kind !== "http")
    return yield* Effect.die("Expected HTTP status evidence");
  expect(result.failure.diagnostic.status).toBe(status);
  expect(result.failure.diagnostic.tenant?.lookups).toBe("0");
  expect(result.failure.diagnostic.tenant?.rpcs).toBe("0");
});

const snapshot = (url: string, key: string) =>
  observe(
    auditedObservation("tenant", `${url}/snapshot?key=${key}`, TenantSnapshot),
    { until: () => true, budgetMs: 5000 },
  );

const provider = (url: string) =>
  observe(auditedObservation("provider", `${url}/snapshot`, ProviderSnapshot), {
    until: () => true,
    budgetMs: 5000,
  });

const waitMessages = (url: string, parent: string) =>
  observe(auditedObservation("provider", `${url}/snapshot`, ProviderSnapshot), {
    until: (value) =>
      value.messages.some(
        (message) => message.body.reply_parent_message_id === parent,
      ),
    budgetMs: 5000,
  });

const sourceControl = (
  url: string,
  key: string,
  body: Schema.Json,
  delayMs = 0,
  status = 200,
) => post(`${url}/control`, { key, body, delayMs, status });

const baseReceipt = (id: string, receivedAt = Date.now()) => ({
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
      source: journeyUrl(deployed.sourceUrl, "bot"),
      provider: journeyUrl(deployed.providerUrl, "bot"),
      workerName: deployed.workerName,
    };
  });

  const receipt = Effect.fnUntraced(function* (
    id: string,
    remote: (typeof ProviderSnapshot.Type)["remote"][number],
    receivedAt = Date.now(),
  ) {
    const u = yield* urls;

    const source = yield* request(`${u.tenant}/source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: remote.id,
        status: remote.status,
        broadcasterId: "200",
        senderId: remote.condition.user_id,
        callback: `${u.bot}/webhooks/twitch`,
        binding: yield* subscriptionBinding({
          callback: `${u.bot}/webhooks/twitch`,
          clientId: "fixture-twitch",
          signingSecret: Redacted.make("fixture-signing"),
        }),
      }),
    }).pipe(
      Effect.flatMap((response) =>
        json(
          response,
          Schema.Struct({
            kind: Schema.Literal("success"),
            value: SubscriptionAdmission,
          }),
        ),
      ),
    );

    if (!source.value)
      return yield* Effect.die(
        "Native Tenant admission requires exact owned enabled proof",
      );

    return { ...baseReceipt(id, receivedAt), source: source.value };
  });

  const signedDiscord = Effect.fnUntraced(function* (
    bot: string,
    value: Schema.Json,
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
      const workerMs = ingressTiming(response.headers);

      const trace = responseMetadata(response)?.tenant;

      const sample = {
        scenario,
        reply,
        workerMs,
        clientMs: elapsed,
        status: response.status,
        flags: reply.data.flags,
        content: reply.data.content,
        fallback: trace?.fallback ?? null,
        fallbackCode: trace?.fallbackCode ?? null,
        tenantPhase: trace?.phase ?? null,
        tenantCode: trace?.code ?? null,
        admissionDeltaMs: trace?.admissionDeltaMs
          ? Number(trace.admissionDeltaMs)
          : null,
        cutoff: trace?.cutoff ? Number(trace.cutoff) : null,
        activation: trace?.activation ?? null,
      };

      const { reply: _reply, content: _content, ...timing } = sample;
      yield* retainJourney(`bot-${scenario}`, timing);
      console.info(
        JSON.stringify({
          discordTiming: scenario,
          workerMs,
          clientMs: elapsed,
          tenantPhase: sample.tenantPhase,
          tenantCode: sample.tenantCode,
          admissionDeltaMs: sample.admissionDeltaMs,
          cutoff: sample.cutoff,
          fallback: sample.fallback,
          fallbackCode: sample.fallbackCode,
        }),
      );

      expect(workerMs).toBeGreaterThanOrEqual(0);
      expect(workerMs).toBeLessThan(3000);

      return { response, reply, sample };
    }

    return { response, reply: null, sample: null };
  });

  const signedTwitch = Effect.fnUntraced(function* (
    bot: string,
    event: Schema.Json,
    id: string,
    type = "notification",
    at = Date.now(),
  ) {
    const bytes = encode(event);
    const headers = yield* signTwitch(bytes, id, at, type);

    const response = yield* request(`${bot}/webhooks/twitch`, {
      method: "POST",
      body: bytes,
      headers,
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
        const response = (yield* signedDiscord(
          u.bot,
          JSON.stringify({
            ...discordCommand("wrong"),
            ...extra,
          }),
        )).response;

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
      yield* sourceControl(u.source, "/items?id=warm-sensors&minimal=true", {
        data: [
          {
            id: "warm-sensors",
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
        discordCommand("cold", "sell", "warm-sensors", "cold-guild"),
        "cold-cache-cold-tenant",
      );

      expect(cold.reply).toEqual(
        discordResponse("Sensors can be sold for 10 coins each"),
      );
      const loaded = yield* get(`${u.source}/observations`, Observations);
      expect(loaded["/items?id=warm-sensors&minimal=true"]).toBe(
        (before["/items?id=warm-sensors&minimal=true"] ?? 0) + 1,
      );

      for (let n = 0; n < 3; n++) {
        const warm = yield* signedDiscord(
          u.bot,
          discordCommand(`warm-${n}`, "sell", "warm-sensors", "cold-guild"),
          "warm-cache-warm-tenant",
        );

        expect(warm.reply).toEqual(
          discordResponse("Sensors can be sold for 10 coins each"),
        );
        expect(warm.sample?.flags).toBe(0);
        expect(warm.sample?.fallback).toBeNull();
      }

      const cached = yield* get(`${u.source}/observations`, Observations);
      expect(cached["/items?id=warm-sensors&minimal=true"]).toBe(
        loaded["/items?id=warm-sensors&minimal=true"],
      );
    }),
    { timeout: 90000 },
  );

  const prepareBotJourney = Effect.fnUntraced(function* () {
    yield* retainJourney("bot-journey", {
      step: "actual Bot account sees its origin, signed challenge stays pending and ordinary personal chat allocates no channel tenant",
      phase: "start",
    });
    const u = yield* urls;
    yield* post(`${u.provider}/control`, { remote: [], resetMessages: true });

    return yield* withProviderControl(
      u.provider,
      { createStatus: "webhook_callback_verification_pending" },
      Effect.fnUntraced(function* () {
        const first = yield* setup(u.bot);
        expect(first.authorizations.length).toBeGreaterThan(0);

        for (const authorization of first.authorizations) {
          const params = new URL(authorization.url).searchParams;
          expect(params.get("redirect_uri")).toBe(
            `${u.bot}/oauth/twitch/callback`,
          );

          const completion = yield* post(`${u.tenant}/operator-oauth`, {
            state: params.get("state") ?? "",
            code: JSON.stringify({
              userId: authorization.login === "fixture_sender" ? "100" : "200",
              login: authorization.login,
              scopes: params.get("scope")?.split(" "),
              clientId: "fixture-twitch",
            }),
          });

          expect(
            yield* json(
              completion,
              Schema.Struct({ completed: Schema.Literal(true) }),
            ),
          ).toEqual({ completed: true });
        }

        const pending = yield* status(u.bot).pipe(
          Effect.repeat({
            until: (value) =>
              value.channels.some(
                (channel) =>
                  channel.subscription ===
                  "webhook_callback_verification_pending",
              ),
            times: 60,
            schedule: Schedule.spaced("100 millis"),
          }),
        );

        expect(pending.setup).toBe("pending");
        expect(
          pending.channels.some(
            (channel) =>
              channel.subscription === "webhook_callback_verification_pending",
          ),
        ).toBe(true);

        const remote = (yield* provider(u.provider)).remote.find(
          (entry) => entry.transport.callback === `${u.bot}/webhooks/twitch`,
        );

        if (!remote)
          return yield* Effect.die("Actual Bot subscription missing");

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

        for (const text of [
          "hello",
          "!unknown sensors",
          "ARC: !sell sensors",
        ]) {
          const event = twitchEvent(text, text, `${u.bot}/webhooks/twitch`);
          event.subscription.id = remote.id;
          const ignored = yield* signedTwitch(u.bot, event, text);
          expect(ignored.status).toBe(204);
          noTenant(ignored);
        }

        expect((yield* status(u.bot)).setup).toBe("ready");
        expect((yield* provider(u.provider)).messages).toEqual([]);

        return remote;
      }),
    );
  });

  const verifyTenCommands = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "all ten commands execute through actual Bot routes, cache and accepted account dispatch on both transports",
      phase: "start",
    });
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
    yield* sourceControl(u.source, "/items?id=sensors&includeComponents=true", {
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

    const remote = proof;

    const twitchSamples: {
      scenario: string;
      workerAckMs: number;
      clientAckMs: number;
      observedDeliveryClientMs: number;
    }[] = [];

    const discordSamples: string[] = [];

    for (const [command, input, text] of cases) {
      const discord = yield* signedDiscord(
        u.bot,
        discordCommand(`all-${command}`, command, input),
        `command-${command}`,
      );

      expect(discord.reply).toEqual(discordResponse(text));
      expect(discord.sample?.flags).toBe(0);
      expect(discord.sample?.fallback).toBeNull();
      expect(discord.sample?.tenantPhase).toBe("committed");
      discordSamples.push(command);

      const event = twitchEvent(
        `all-${command}`,
        `!${command} ${input}`,
        `${u.bot}/webhooks/twitch`,
      );

      event.subscription.id = remote.id;

      const afterDiscord = yield* get(`${u.source}/observations`, Observations);

      const receivedAt = Date.now();

      const ackStart = performance.now();

      const admitted = yield* signedTwitch(
        u.bot,
        event,
        `notification-${command}`,
      );

      const timing = {
        start: ackStart,
        workerAckMs: ingressTiming(admitted.headers),
        clientAckMs: performance.now() - ackStart,
      };

      yield* retainJourney(`bot-command-${command}`, {
        phase: "ack",
        workerAckMs: timing.workerAckMs,
        clientAckMs: timing.clientAckMs,
      });

      expect(admitted.status).toBe(204);
      expect(admitted.headers.get("x-arc-tenant-lookups")).toBe("1");
      expect(admitted.headers.get("x-arc-tenant-rpcs")).toBe("1");

      const sent = (yield* waitMessages(
        u.provider,
        `all-${command}`,
      )).messages.find(
        (message) => message.body.reply_parent_message_id === `all-${command}`,
      );

      const sample = {
        scenario: command,
        workerAckMs: timing.workerAckMs,
        clientAckMs: timing.clientAckMs,
        observedDeliveryClientMs: performance.now() - timing.start,
      };

      twitchSamples.push(sample);
      yield* retainJourney(`bot-command-${command}`, sample);
      expect(sample.workerAckMs).toBeGreaterThanOrEqual(0);
      expect(sample.workerAckMs).toBeLessThan(3000);
      expect(sent?.body.message).toBe(text);
      expect(sent?.at).toBeLessThan(receivedAt + 10000);
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
    expect(discordSamples).toHaveLength(10);
    expect(twitchSamples).toHaveLength(10);
  });

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

        const { sample } = yield* signedDiscord(
          u.bot,
          discordCommand(name, "sell", name, `${name}-guild`),
          name,
        );

        const after = yield* get(`${u.source}/observations`, Observations);
        expect(after[`/items?id=${name}&minimal=true`]).toBe(
          (before[`/items?id=${name}&minimal=true`] ?? 0) + 1,
        );

        if (!sample) return yield* Effect.die("Data failure sample missing");
        expectDataFailure(name, sample);
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
      ).pipe(Effect.forkScoped);

      yield* Effect.sleep(100);

      const second = yield* signedDiscord(
        u.bot,
        invocation,
        "concurrent-duplicate",
      ).pipe(Effect.forkScoped);

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
    }).pipe(Effect.scoped),
    { timeout: 90000 },
  );

  test(
    "native empty recovery clears tenant storage outside a transaction and remains idempotent",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "native-empty-cleanup";
      expect(
        (yield* post(`${u.tenant}/control`, {
          key,
          control: { immediate: true },
        })).status,
      ).toBe(204);
      expect((yield* post(`${u.tenant}/recover`, { key })).status).toBe(204);
      expect((yield* post(`${u.tenant}/recover`, { key })).status).toBe(204);
      const cleared = yield* snapshot(u.tenant, key);
      expect(cleared.state).toBeNull();
      expect(cleared.alarm).toBeNull();
    }),
    { timeout: 90000 },
  );

  const verifyNativeTenantDelivery = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "native Tenant admission persists a useful alarm before acknowledgement and reconstructs into one delivery",
      phase: "start",
    });
    const u = yield* urls;
    const key = "native-alarm";
    const input = yield* receipt("native-alarm", proof);
    expect(
      (yield* post(`${u.tenant}/accept`, { key, receipt: input })).status,
    ).toBe(204);
    const admitted = yield* snapshot(u.tenant, key);
    yield* retainJourney("bot-native-delivery", {
      boundary: "admitted",
      snapshot: admitted,
    });
    const original = admitted.state?.works[key];

    if (!original) return yield* Effect.die("Admitted native work missing");
    expect(original).toMatchObject({
      id: input.id,
      fingerprint: input.fingerprint,
      receivedAt: input.receivedAt,
      deadline: input.receivedAt + 10000,
      retainUntil: input.receivedAt + 610000,
    });
    expect(hasUsefulNativeSchedule(admitted, original.deadline)).toBeTrue();
    expect((yield* post(`${u.tenant}/reconstruct`, { key })).status).toBe(204);

    const rebuilt = yield* reconstructedSnapshot(
      snapshot(u.tenant, key),
      admitted.instance,
    );

    yield* retainJourney("bot-native-delivery", {
      boundary: "reconstructed",
      snapshot: rebuilt,
    });
    const rebuiltWork = rebuilt.state?.works[key];

    if (!rebuiltWork)
      return yield* Effect.die("Reconstructed native work missing");
    expect(immutableWork(rebuiltWork)).toEqual(immutableWork(original));
    expect(hasUsefulNativeSchedule(rebuilt, original.deadline)).toBeTrue();

    const completed = yield* observe(
      auditedObservation(
        "tenant",
        `${u.tenant}/snapshot?key=${key}`,
        TenantSnapshot,
      ),
      {
        until: (value) =>
          value.state?.works["native-alarm"]?.kind === "terminal",
        budgetMs: 45000,
      },
    );

    yield* retainJourney("bot-native-delivery", {
      boundary: "completed",
      snapshot: completed,
    });
    const terminal = completed.state?.works[key];

    if (!terminal) return yield* Effect.die("Completed native work missing");
    expect(immutableWork(terminal)).toEqual(immutableWork(original));
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
    expect(completed.alarm).toBe(input.receivedAt + 610000);
    expect(JSON.stringify(completed.state)).not.toContain("parent");
    yield* Effect.sleep(Math.max(0, input.receivedAt + 10_100 - Date.now()));
    yield* post(`${u.tenant}/accept`, {
      key,
      receipt: { ...input, receivedAt: Date.now() },
    });
    yield* post(`${u.tenant}/recover`, { key });
    const replayed = yield* snapshot(u.tenant, key);
    const replayedWork = replayed.state?.works[key];

    if (!replayedWork) return yield* Effect.die("Replayed native work missing");
    expect(immutableWork(replayedWork)).toEqual(immutableWork(original));

    expect(
      (yield* provider(u.provider)).messages.filter(
        (message) => message.body.reply_parent_message_id === "native-alarm",
      ),
    ).toHaveLength(1);
  });

  const verifyLostAccountCompletion = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "lost tenant account completion reuses the persisted dispatch without a second external POST",
      phase: "start",
    });
    const u = yield* urls;
    const key = "lost-rpc";
    yield* post(`${u.tenant}/control`, {
      key,
      control: { immediate: true, loseAccountResponse: true },
    });
    const input = yield* receipt("lost-rpc", proof);
    expect(
      (yield* post(`${u.tenant}/accept`, { key, receipt: input })).status,
    ).toBe(204);

    const completed = yield* observe(
      auditedObservation(
        "tenant",
        `${u.tenant}/snapshot?key=${key}`,
        TenantSnapshot,
      ),
      {
        until: (value) => value.state?.works["lost-rpc"]?.kind === "terminal",
        budgetMs: 45000,
      },
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
    expect(completed.alarm).toBe(input.receivedAt + 610000);
  });

  const verifySlowMultipart = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "native recovery joins a live slow account POST and completes its multipart plan",
      phase: "start",
    });
    const u = yield* urls;
    const key = "slow-account-send";
    yield* sourceControl(u.source, "/items?id=slowparts&minimal=true", {
      data: [{ id: "slowparts", name: "x".repeat(650), value: 10 }],
    });
    yield* withProviderControl(
      u.provider,
      { holdSend: true },
      Effect.fnUntraced(function* (control) {
        yield* post(`${u.tenant}/control`, {
          key,
          control: { immediate: true },
        });

        const input = {
          ...(yield* receipt(key, proof)),
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

        const alarm = yield* observe(
          auditedObservation(
            "tenant",
            `${u.tenant}/snapshot?key=${key}`,
            TenantSnapshot,
          ),
          {
            until: (value) =>
              value.alarmRuns > 0 && Date.now() >= work.claim.until,
            budgetMs: 45000,
          },
        );

        expect(alarm.alarmRuns).toBeGreaterThan(0);
        expect(alarm.state?.works[key]?.kind).toBe("delivering");
        yield* control.release;

        const terminal = yield* observe(
          auditedObservation(
            "tenant",
            `${u.tenant}/snapshot?key=${key}`,
            TenantSnapshot,
          ),
          {
            until: (value) => value.state?.works[key]?.kind === "terminal",
            budgetMs: 45000,
          },
        );

        expect(terminal.state?.works[key]).toMatchObject({
          kind: "terminal",
          outcome: "sent",
          deadline: input.receivedAt + 10000,
        });
        expect(terminal.alarm).toBe(input.receivedAt + 610000);
        expect(
          (yield* provider(u.provider)).messages.filter(
            (message) => message.body.reply_parent_message_id === key,
          ),
        ).toHaveLength(2);
      }),
    );
  });

  test(
    "native Discord interruption commits one private response at the original deadline without a late message",
    Effect.gen(function* () {
      const u = yield* urls;
      const key = "discord-interrupted";
      const sourceKey = "/items?id=interrupt&minimal=true";
      yield* withSourceHold(
        u.source,
        {
          key: sourceKey,
          body: { data: [{ id: "interrupt", name: "Interrupted", value: 10 }] },
        },
        Effect.fnUntraced(function* (control) {
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
          }).pipe(
            Effect.result,
            Effect.onExit((exit) => {
              if (Exit.isFailure(exit))
                return Effect.logInfo("discord-interruption-request", {
                  kind: "fiber-failure",
                  reasons: exit.cause.reasons.map((reason) => reason._tag),
                });
              const result = exit.value;

              return Effect.logInfo("discord-interruption-request", {
                observedAt: Date.now(),
                elapsedMs: Date.now() - input.receivedAt,
                result: Predicate.isTagged(result, "Success")
                  ? { kind: "response", status: result.success.status }
                  : Predicate.isTagged(result.failure, "FixtureRequestError")
                    ? {
                        kind: "http-failure",
                        diagnostic: result.failure.diagnostic,
                      }
                    : {
                        kind: "request-failure",
                        errorType: "unknown",
                      },
              });
            }),
            Effect.forkScoped,
          );

          const admitted = yield* observe(
            auditedObservation(
              "tenant",
              `${u.tenant}/snapshot?key=${key}`,
              TenantSnapshot,
            ),
            {
              until: (value) => {
                expect(original.pollUnsafe()).toBeUndefined();

                return value.state?.works.interrupt?.kind === "computing";
              },
              budgetMs: 5000,
            },
          );

          yield* Effect.logInfo("discord-interruption-admission", {
            observedAt: Date.now(),
            elapsedMs: Date.now() - input.receivedAt,
            requestState: original.pollUnsafe()?._tag ?? "pending",
            instance: admitted.instance,
            alarm: admitted.alarm,
            alarmRuns: admitted.alarmRuns,
            state:
              admitted.state === null
                ? null
                : {
                    generation: admitted.state.generation,
                    works: Object.values(admitted.state.works).map((work) => ({
                      id: work.id,
                      kind: work.kind,
                      transport: work.transport,
                      receivedAt: work.receivedAt,
                      deadline: work.deadline,
                      claim: "claim" in work ? work.claim : null,
                    })),
                  },
          });
          expect(admitted.state?.works.interrupt?.kind).toBe("computing");

          const observed = yield* observe(
            auditedObservation(
              "source",
              `${u.source}/observations`,
              Observations,
            ),
            { until: (value) => value[sourceKey] === 1, budgetMs: 5000 },
          );

          expect(observed[sourceKey]).toBe(1);
          expect(original.pollUnsafe()).toBeUndefined();
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
          expect(terminal.alarm).toBe(input.receivedAt + 603000);
          expect(JSON.stringify(terminal.state)).not.toContain("CANARY");
          expect(JSON.stringify(terminal.state)).not.toContain("invocation");
          yield* control.release;
          const interrupted = yield* Fiber.join(original);

          if (Predicate.isTagged(interrupted, "Failure")) {
            expect(
              Predicate.isTagged(interrupted.failure, "FixtureRequestError"),
            ).toBeTrue();

            if (Predicate.isTagged(interrupted.failure, "FixtureRequestError"))
              expect(
                interrupted.failure.diagnostic.kind === "http"
                  ? interrupted.failure.diagnostic.status
                  : null,
              ).toBe(500);
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
      );
    }).pipe(Effect.scoped),
    { timeout: 90000 },
  );

  const verifyAmbiguousMultipart = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "actual account ambiguity stops the remaining Twitch parts and replay starts no second POST",
      phase: "start",
    });
    const u = yield* urls;
    yield* sourceControl(u.source, "/items?id=long&minimal=true", {
      data: [{ id: "long", name: "x".repeat(1200), value: 10 }],
    });
    yield* withProviderControl(
      u.provider,
      {
        sendStatus: 200,
        sendBody: { data: [{ is_sent: "invalid", message_id: "" }] },
      },
      Effect.fnUntraced(function* () {
        const remote = proof;

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
      }),
    );
  });

  const verifySignedRevocation = Effect.fnUntraced(function* (
    proof: (typeof ProviderSnapshot.Type)["remote"][number],
  ) {
    yield* retainJourney("bot-journey", {
      step: "verified revocation is durable before acknowledgement and blocks the actual account",
      phase: "start",
    });
    const u = yield* urls;

    const remote = proof;
    expect(
      (yield* signedTwitch(
        u.bot,
        { subscription: { ...remote, status: "authorization_revoked" } },
        "revoke",
        "revocation",
      )).status,
    ).toBe(204);
    const revoked = yield* status(u.bot);
    expect(
      revoked.channels.some(
        (entry) => entry.id === remote.condition.broadcaster_user_id,
      ),
    ).toBeFalse();
    expect(revoked.sender?.authorized).toBeTrue();
  });

  test(
    "actual Bot onboarding, ten commands, native recovery, ambiguity and signed revocation",
    Effect.gen(function* () {
      const proof = yield* prepareBotJourney();
      yield* verifyTenCommands(proof);
      yield* verifyNativeTenantDelivery(proof);
      yield* verifyLostAccountCompletion(proof);
      yield* verifySlowMultipart(proof);
      yield* verifyAmbiguousMultipart(proof);
      yield* verifySignedRevocation(proof);
    }),
    { timeout: 360_000 },
  );
}
