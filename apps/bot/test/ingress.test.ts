import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Result, Clock, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { TestClock } from "effect/testing";

import {
  discordCommand,
  discordPublicKey,
  negativeFutureStamp,
  signDiscord,
  signTwitch,
  twitchEvent,
} from "../../../tests/cloud/signatures.js";
import { BotApi } from "../src/api.js";
import { publicOrigin } from "../src/config.js";
import {
  ingressHandlers,
  parseTwitchCommand,
  readBody,
} from "../src/ingress.js";
import { operatorHandlers } from "../src/operator.js";
import { discordResponse } from "../src/presentation.js";
import {
  TenantError,
  type TenantService,
  Tenants,
} from "../src/tenant-contracts.js";
import {
  type Account,
  AccountError,
  AccountStatus,
  type SubscriptionObservation,
  TwitchAccount,
} from "../src/twitch-contracts.js";
import { identity } from "./subscription-fixture.js";
import { tenantFixture } from "./tenant-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const callback = "https://bot.invalid/webhooks/twitch";

const encode = (value: Schema.Json) =>
  new TextEncoder().encode(
    Schema.is(Schema.String)(value) ? value : JSON.stringify(value),
  );

const fixture = Effect.fnUntraced(function* (
  options: {
    receivedAt?: number;
    tenants?: Partial<TenantService>;
    observation?: (
      input: SubscriptionObservation,
    ) => Effect.Effect<void, AccountError>;
  } = {},
) {
  const now = options.receivedAt ?? Date.now();
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
            status: "ready",
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
    value: Schema.Json,
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
    value: Schema.Json,
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
    receivedAt: now,
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

        const signed = yield* signDiscord(body, f.receivedAt);
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
          (yield* f.twitch(twitchEvent("message"), f.receivedAt - 600001))
            .status,
        ).toBe(401);
        expect(
          (yield* f.twitch(twitchEvent("message"), f.receivedAt + 30001))
            .status,
        ).toBe(401);
        expect(
          (yield* f.discord(discordCommand("id"), f.receivedAt - 301000))
            .status,
        ).toBe(401);
        expect(
          (yield* f.discord(discordCommand("id"), f.receivedAt + 31000)).status,
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
            yield* signDiscord(bad, f.receivedAt),
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
          const response = yield* f.discord(
            JSON.stringify({
              ...discordCommand("id"),
              ...extra,
            }),
          );

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
    "slash options trim before empty values are omitted from the invocation",
    Effect.gen(function* () {
      const f = yield* fixture();

      const options: ReadonlyArray<readonly [string, string, string]> = [
        ["blank", " \t ", ""],
        ["trimmed", "  sensors\t ", "sensors"],
        ["internal", " heavy  gun parts ", "heavy  gun parts"],
      ];

      for (const [id, input, expected] of options) {
        expect(
          (yield* f.discord(discordCommand(id, "sell", input))).status,
        ).toBe(200);
        expect(f.admissions.at(-1)).toMatchObject({
          id,
          invocation: { command: "sell", input: expected },
        });
      }

      expect(f.admissions).toHaveLength(3);
    }),
  );
  test(
    "authentication header schema failures stay 401 before account reads",
    Effect.gen(function* () {
      const f = yield* fixture();
      const body = encode(twitchEvent("headers"));
      const twitch = yield* signTwitch(body, "event", f.receivedAt);

      for (const headers of [
        { ...twitch, "twitch-eventsub-message-id": "" },
        { ...twitch, "twitch-eventsub-message-id": "x".repeat(129) },
        { ...twitch, "twitch-eventsub-message-timestamp": "123" },
        {
          ...twitch,
          "twitch-eventsub-message-signature": `sha256=${"g".repeat(64)}`,
        },
      ])
        expect(
          (yield* f.request("/webhooks/twitch", body, headers)).status,
        ).toBe(401);
      const discordBody = encode(discordCommand("headers"));
      const discord = yield* signDiscord(discordBody, f.receivedAt);

      for (const headers of [
        {},
        { ...discord, "x-signature-timestamp": "" },
        { ...discord, "x-signature-timestamp": "1.5" },
        { ...discord, "x-signature-ed25519": "g".repeat(128) },
      ])
        expect(
          (yield* f.request("/interactions/discord", discordBody, headers))
            .status,
        ).toBe(401);
      expect(f.reads()).toBe(0);
      expect(f.admissions).toEqual([]);
    }),
  );
  test(
    "signed delivery-type errors retain their validation position and never observe or admit",
    Effect.gen(function* () {
      const f = yield* fixture();
      const body = encode(twitchEvent("delivery"));
      const signed = yield* signTwitch(body, "event", f.receivedAt);
      expect(
        (yield* f.request("/webhooks/twitch", body, {
          ...signed,
          "twitch-eventsub-subscription-version": "2",
        })).status,
      ).toBe(400);
      expect(f.reads()).toBe(0);

      for (const type of ["", "unknown", "Notification"])
        expect(
          (yield* f.request("/webhooks/twitch", body, {
            ...signed,
            "twitch-eventsub-message-type": type,
          })).status,
        ).toBe(400);
      expect(f.reads()).toBe(3);
      expect(f.observations).toEqual([]);
      expect(f.admissions).toEqual([]);
    }),
  );
  test(
    "ordinary chat and unknown commands allocate no tenant",
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
            receivedAt: f.receivedAt,
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
          f.receivedAt,
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
            f.receivedAt,
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
    "tagged tenant failures preserve only their known code in the private fallback",
    Effect.gen(function* () {
      const f = yield* fixture({
        tenants: {
          respondDiscord: () => new TenantError({ code: "capacity" }),
        },
      });

      const response = yield* f.discord(discordCommand("capacity"));
      expect(response.headers.get("x-arc-command-code")).toBe("capacity");
      expect(yield* json(response)).toEqual(
        discordResponse(
          "I couldn't finish that command in time. Please try again.",
          true,
        ),
      );

      const unknown = yield* fixture({
        tenants: {
          respondDiscord: () =>
            Effect.die(
              Schema.TaggedStruct("TenantError", { code: Schema.String }).make({
                code: "CANARY-SECRET",
              }),
            ),
        },
      });

      const failed = yield* unknown.discord(discordCommand("unknown"));
      expect(failed.headers.get("x-arc-command-code")).toBe("rpc-defect");
      expect(JSON.stringify(yield* json(failed))).not.toContain(
        "CANARY-SECRET",
      );
    }),
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

test(
  "an unfinished raw body is interrupted at its bounded read timeout",
  Effect.gen(function* () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
    });

    const request = HttpServerRequest.fromWeb(
      new Request("https://bot.invalid/interactions/discord", {
        method: "POST",
        body: stream,
      }),
    );

    const result = yield* readBody(request).pipe(
      Effect.result,
      Effect.forkChild,
    );

    yield* TestClock.adjust(750);
    expect(yield* Fiber.join(result)).toMatchObject(
      Result.fail({ status: 408 }),
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

for (const delta of [-1, -20, 3000])
  test(
    `signed ingress preserves its original stamp with Tenant clock delta ${delta}`,
    Effect.gen(function* () {
      const tenant = yield* tenantFixture();
      const service = yield* tenant.construct();
      const clock = yield* Clock.Clock;

      const f = yield* fixture({
        tenants: {
          respondDiscord: (receipt) =>
            service
              .respondDiscord(receipt)
              .pipe(Effect.provideService(Clock.Clock, clock)),
        },
      });

      yield* TestClock.setTime(f.receivedAt + delta);
      const response = yield* f.discord(discordCommand(`clock-${delta}`));
      const reply = yield* json(response);

      if (delta < 3000) {
        expect(reply).toEqual(
          discordResponse("Sensors can be sold for 10 coins each"),
        );
        expect(tenant.snapshot().works[`clock-${delta}`]).toMatchObject({
          kind: "terminal",
          receivedAt: f.receivedAt,
          deadline: f.receivedAt + 3000,
        });
        expect(tenant.source.calls).toHaveLength(1);
      } else {
        expect(reply).toMatchObject({ data: { flags: 64 } });
        expect(Object.values(tenant.snapshot().works)).toHaveLength(0);
        expect(tenant.source.calls).toHaveLength(0);
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

for (const transport of ["discord", "twitch"] as const)
  test(
    `cloud ${transport} future-signature control stays outside production skew after bounded transport`,
    Effect.scoped(
      Effect.gen(function* () {
        const sentAt = Math.floor(Date.now() / 1000) * 1000;
        const f = yield* fixture({ receivedAt: sentAt + 20000 });

        const response =
          transport === "discord"
            ? yield* f.discord(
                discordCommand("delayed-future"),
                negativeFutureStamp(sentAt),
              )
            : yield* f.twitch(
                twitchEvent("delayed-future"),
                negativeFutureStamp(sentAt),
              );

        expect(response.status).toBe(401);
        expect(f.admissions).toHaveLength(0);
        expect(f.reads()).toBe(0);
      }),
    ),
  );
