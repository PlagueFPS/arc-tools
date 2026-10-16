import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  discordCommand,
  discordPublicKey,
  signDiscord,
  signTwitch,
  twitchEvent,
} from "../../../tests/cloud/signatures.js";
import { BotApi } from "../src/api.js";
import { publicOrigin } from "../src/config.js";
import { ingressHandlers, parseTwitchCommand } from "../src/ingress.js";
import { operatorHandlers } from "../src/operator.js";
import { discordResponse } from "../src/presentation.js";
import { type TenantService, Tenants } from "../src/tenant-contracts.js";
import {
  type Account,
  AccountError,
  AccountStatus,
  type SubscriptionObservation,
  TwitchAccount,
} from "../src/twitch-contracts.js";
import { identity } from "./subscription-fixture.js";

const { test } = Test.make({ providers: Layer.empty });
const now = Date.now();
const callback = "https://bot.invalid/webhooks/twitch";
const encode = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
const fixture = Effect.fnUntraced(function* (
  options: {
    tenants?: Partial<TenantService>;
    observation?: (
      input: SubscriptionObservation,
    ) => Effect.Effect<void, AccountError>;
  } = {},
) {
  const admissions: unknown[] = [];
  const observations: SubscriptionObservation[] = [];
  let reads = 0;
  const status = Schema.decodeUnknownSync(AccountStatus)({
    stage: identity.stage,
    revision: "r",
    setup: "ready",
    credential: "valid",
    sender: { id: "100", login: "fixture_sender", authorized: true },
    channels: [
      {
        id: "200",
        login: "fixture_channel",
        authorized: true,
        subscription: "enabled",
      },
    ],
    attempts: 0,
    credentialCheckAt: null,
  });
  const account: Account = {
    status: () =>
      Effect.sync(() => {
        reads++;
        return status;
      }),
    dispatch: () => Effect.succeed({ kind: "rejected" }),
    setup: () => new AccountError({ code: "configuration" }),
    completeOAuth: () => new AccountError({ code: "configuration" }),
    observeSubscription: (input) =>
      Effect.sync(() => {
        observations.push(input);
      }).pipe(Effect.andThen(options.observation?.(input) ?? Effect.void)),
  };
  const tenants = Tenants.of({
    acceptTwitch: (receipt) =>
      Effect.sync(() => {
        admissions.push(receipt);
        return { kind: "accepted" };
      }),
    respondDiscord: (receipt) =>
      Effect.sync(() => {
        admissions.push(receipt);
        return discordResponse("Sensors can be sold for 10 coins each");
      }),
    ...options.tenants,
  });
  const handlers = HttpApiBuilder.layer(BotApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(BotApi, "health", (handlers) =>
        handlers.handle("health", () =>
          Effect.succeed({
            status: "foundation",
            stage: identity.stage,
            revision: "r",
            manifestHash: "h",
          }),
        ),
      ),
    ),
    Layer.provide(operatorHandlers(identity.stage, Redacted.make("operator"))),
    Layer.provide(
      ingressHandlers({
        identity,
        twitchSigningSecret: Redacted.make("fixture-signing"),
        discordPublicKey,
        callback,
        receivedAt: now,
      }),
    ),
    Layer.provide(Layer.succeed(TwitchAccount, account)),
    Layer.provide(Layer.succeed(Tenants, tenants)),
    Layer.provide(HttpServer.layerServices),
  );
  const app = HttpRouter.toWebHandler(handlers, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  const request = (
    path: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ) =>
    Effect.promise(() =>
      app.handler(
        new Request(`https://bot.invalid${path}`, {
          method: "POST",
          body: new Uint8Array(body),
          headers,
        }),
      ),
    );
  const discord = Effect.fnUntraced(function* (
    value: unknown,
    timestamp = now,
  ) {
    const body = encode(value);
    return yield* request(
      "/interactions/discord",
      body,
      yield* signDiscord(body, timestamp),
    );
  });
  const twitch = Effect.fnUntraced(function* (
    value: unknown,
    timestamp = now,
    type = "notification",
  ) {
    const body = encode(value);
    return yield* request(
      "/webhooks/twitch",
      body,
      yield* signTwitch(body, "event", timestamp, type),
    );
  });
  return {
    request,
    discord,
    twitch,
    admissions,
    observations,
    reads: () => reads,
  };
});
const json = (response: Response) => Effect.promise(() => response.json());

describe("signed HttpApi ingress", () => {
  test(
    "Ed25519 PING preserves raw whitespace and needs no guild or tenant",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const body = encode(
          ' { "application_id" : "fixture-discord", "type" : 1 }\r\n',
        );
        const signed = yield* signDiscord(body, now);
        expect(
          yield* json(yield* f.request("/interactions/discord", body, signed)),
        ).toEqual({ type: 1 });
        expect(
          (yield* f.request(
            "/interactions/discord",
            encode(JSON.parse(new TextDecoder().decode(body))),
            signed,
          )).status,
        ).toBe(401);
        expect(f.admissions).toEqual([]);
        expect(f.reads()).toBe(0);
      }),
    ),
  );
  test(
    "invalid signatures, stale and future timestamps never read account or tenant state",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const body = encode(twitchEvent("message"));
        expect((yield* f.request("/webhooks/twitch", body, {})).status).toBe(
          401,
        );
        expect(
          (yield* f.twitch(twitchEvent("message"), now - 600001)).status,
        ).toBe(401);
        expect(
          (yield* f.twitch(twitchEvent("message"), now + 30001)).status,
        ).toBe(401);
        expect(
          (yield* f.discord(discordCommand("id"), now - 301000)).status,
        ).toBe(401);
        expect(
          (yield* f.discord(discordCommand("id"), now + 31000)).status,
        ).toBe(401);
        expect(f.admissions).toEqual([]);
        expect(f.reads()).toBe(0);
      }),
    ),
  );
  test(
    "bounded original bytes reject oversize, invalid UTF-8 and malformed JSON with distinct HTTP errors",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const huge = encode("x".repeat(65537));
        expect(
          (yield* f.request("/interactions/discord", huge, {})).status,
        ).toBe(413);
        const bad = new Uint8Array([255, 0, 13, 10]);
        expect(
          (yield* f.request(
            "/interactions/discord",
            bad,
            yield* signDiscord(bad, now),
          )).status,
        ).toBe(400);
        expect((yield* f.discord("{")).status).toBe(400);
        expect(f.admissions).toEqual([]);
        expect(f.reads()).toBe(0);
      }),
    ),
  );
  test(
    "Discord application, guild installation, member and slash context reject privately without allocating a tenant",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const extra of [
          { application_id: "other" },
          { guild_id: undefined },
          { context: 1 },
          { member: undefined },
          { authorizing_integration_owners: { "0": "elsewhere" } },
          { data: { name: "sell", type: 2 } },
          { data: { name: "missing", type: 1 } },
        ]) {
          const response = yield* f.discord({
            ...discordCommand("id"),
            ...extra,
          });
          expect(response.status).toBe(200);
          expect(yield* json(response)).toMatchObject({
            type: 4,
            data: {
              flags: 64,
              allowed_mentions: { parse: [], replied_user: false },
            },
          });
        }
        expect(f.admissions).toEqual([]);
        expect(yield* json(yield* f.discord(discordCommand("good")))).toEqual(
          discordResponse("Sensors can be sold for 10 coins each"),
        );
        expect(f.admissions).toHaveLength(1);
        expect(JSON.stringify(f.admissions)).not.toContain("CANARY");
      }),
    ),
  );
  test(
    "ordinary chat, unknown commands and generated personal replies allocate no tenant",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const text of ["hello", "!unknown sensors", "ARC: !sell sensors"])
          expect((yield* f.twitch(twitchEvent(text, text))).status).toBe(204);
        expect(f.admissions).toEqual([]);
        expect(
          (yield* f.twitch(twitchEvent("personal", "!SeLl   sensors "))).status,
        ).toBe(204);
        expect(f.admissions).toMatchObject([
          {
            invocation: { command: "sell", input: "sensors" },
            receivedAt: now,
          },
        ]);
        expect(f.observations).toHaveLength(4);
        expect(parseTwitchCommand("!recycleto  heavy gun parts")).toEqual({
          command: "recycleto",
          input: "heavy gun parts",
        });
      }),
    ),
  );
  test(
    "Twitch validates signed subscription and event context before tenant allocation",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const event = twitchEvent("message");
        for (const value of [
          { ...event, subscription: { ...event.subscription, version: "2" } },
          {
            ...event,
            subscription: {
              ...event.subscription,
              condition: { broadcaster_user_id: "999", user_id: "100" },
            },
          },
          {
            ...event,
            event: { ...event.event, broadcaster_user_login: "other" },
          },
          {
            ...event,
            subscription: {
              ...event.subscription,
              transport: {
                method: "webhook",
                callback: "https://other.invalid",
              },
            },
          },
        ])
          expect((yield* f.twitch(value)).status).toBe(400);
        expect(f.admissions).toEqual([]);
      }),
    ),
  );
  test(
    "challenges observe pending and return exact bytes; revocation persistence failure prevents acknowledgement",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const event = twitchEvent("message");
        const challenge = {
          subscription: {
            ...event.subscription,
            status: "webhook_callback_verification_pending",
          },
          challenge: "challenge-👋",
        };
        const response = yield* f.twitch(
          challenge,
          now,
          "webhook_callback_verification",
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "challenge-👋",
        );
        expect(f.observations[0]).toMatchObject({
          status: "webhook_callback_verification_pending",
          callback,
        });
        expect(f.observations[0]?.binding).toHaveLength(64);
        const blocked = yield* fixture({
          observation: () => new AccountError({ code: "provider" }),
        });
        expect(
          (yield* blocked.twitch(
            {
              subscription: {
                ...event.subscription,
                status: "authorization_revoked",
              },
            },
            now,
            "revocation",
          )).status,
        ).toBe(503);
        expect(blocked.admissions).toEqual([]);
      }),
    ),
  );
  test(
    "an unknown tenant RPC failure becomes a deterministic private initial response",
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture({
          tenants: {
            respondDiscord: () => Effect.die("synthetic RPC failure"),
          },
        });
        const response = yield* f.discord(discordCommand("id"));
        expect(response.status).toBe(200);
        expect(yield* json(response)).toEqual(
          discordResponse(
            "I couldn't finish that command in time. Please try again.",
            true,
          ),
        );
      }),
    ),
  );
  test(
    "one deployed origin controls callbacks and local tunnels must be explicit validated HTTPS origins",
    Effect.sync(() => {
      expect(
        publicOrigin("prod", "https://bot.example/", "https://bot.example"),
      ).toBe("https://bot.example");
      expect(
        publicOrigin(
          "local-angel",
          "http://localhost:8787",
          "https://tunnel.example",
        ),
      ).toBe("https://tunnel.example");
      for (const origin of [
        "http://other.example",
        "https://other.example/path",
        "https://user:pass@other.example",
        "https://other.example?x=1",
      ])
        expect(() =>
          publicOrigin("prod", "https://bot.example", origin),
        ).toThrow();
      expect(() =>
        publicOrigin("prod", "https://bot.example", "https://other.example"),
      ).toThrow();
      expect(() =>
        publicOrigin("local-angel", "http://localhost:8787", ""),
      ).toThrow();
    }),
  );
});
