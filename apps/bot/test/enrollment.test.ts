import { expect } from "bun:test";

import {
  AccountStatus,
  AccountError,
  EnrollmentStatus,
  TwitchAccount,
  TwitchEnrollment,
  subscriptionBinding,
} from "@arctools/twitch/server";
import { AccountState } from "@arctools/twitch/testing";
import {
  harness,
  fixtureConfig,
  initial,
} from "@arctools/twitch/testing/fixtures";
import { digest } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Match,
  Redacted,
  Schema,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { TestClock } from "effect/testing";

import {
  discordPublicKey,
  signTwitch,
  twitchEvent,
} from "../../../tests/cloud/signatures.js";
import { BotApi } from "../src/api.js";
import { EnvironmentConfig } from "../src/config.js";
import { enrollmentCookie } from "../src/enrollment.js";
import { ingressHandlers } from "../src/ingress.js";
import { operatorHandlers } from "../src/operator.js";
import { discordResponse } from "../src/presentation.js";
import { Tenants } from "../src/tenant-contracts.js";

const { test } = Test.make({ providers: Layer.empty });

const origin = "https://fixture.invalid";

const callback = `${origin}/webhooks/twitch`;

const identity = Schema.decodeUnknownSync(EnvironmentConfig)({
  ...fixtureConfig,
  kind: "production",
  stage: "prod",
  applicationStage: "prod",
  senderKind: "bot",
  discordApplicationId: "controlled-discord",
});

const fixture = Effect.fnUntraced(function* (
  enrollmentDelayMs = 0,
  setupCapacity = false,
) {
  const h = yield* harness(identity);

  const binding = yield* subscriptionBinding({
    callback,
    clientId: identity.twitchClientId,
    signingSecret: Redacted.make("fixture-signing"),
  });

  const account = yield* h.construct("revision-one", binding);
  const admissions: string[] = [];
  const callbackEntered = yield* Deferred.make<void>();

  const handlers = HttpApiBuilder.layer(BotApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(BotApi, "health", (handlers) =>
        handlers.handle("health", () =>
          Effect.succeed({
            status: "ready",
            stage: "prod",
            revision: "controlled",
            manifestHash: "controlled",
          }),
        ),
      ),
    ),
    Layer.provide(operatorHandlers("prod", Redacted.make("operator"))),
    Layer.provide(
      ingressHandlers({
        identity,
        callback,
        receivedAt: initial + 1,
        twitchSigningSecret: Redacted.make("fixture-signing"),
        discordPublicKey,
      }),
    ),
    Layer.provide(
      Layer.succeed(TwitchAccount, {
        ...account.service,
        setup: setupCapacity
          ? () => new AccountError({ code: "capacity" })
          : account.service.setup,
      }),
    ),
    Layer.provide(
      Layer.succeed(TwitchEnrollment, {
        ...account.enrollment,
        complete: (input) =>
          Deferred.succeed(callbackEntered, undefined).pipe(
            Effect.andThen(
              account.enrollment
                .complete(input)
                .pipe(Effect.delay(enrollmentDelayMs)),
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.succeed(Tenants, {
        acceptTwitch: (input) =>
          Effect.sync(() => {
            admissions.push(input.broadcasterId);

            return { kind: "accepted" };
          }),
        respondDiscord: () => Effect.succeed(discordResponse("controlled")),
      }),
    ),
    Layer.provide(Layer.succeed(Clock.Clock, h.clock)),
    Layer.provide(HttpServer.layerServices),
  );

  const app = HttpRouter.toWebHandler(handlers, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));

  const request = (path: string, cookie?: string) =>
    Effect.promise(() =>
      app.handler(
        new Request(`${origin}${path}`, {
          headers: cookie ? { cookie } : undefined,
        }),
      ),
    );

  const begin = Effect.fnUntraced(function* (previous?: string) {
    const response = yield* request("/oauth/twitch/enroll", previous);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = location.searchParams.get("state") ?? "";

    return { response, location, cookie, state };
  });

  const complete = (state: string, cookie: string) =>
    request(
      `/oauth/twitch/callback?state=${encodeURIComponent(state)}&code=controlled-code`,
      cookie,
    );

  const status = Effect.fnUntraced(function* (cookie: string) {
    const response = yield* request("/oauth/twitch/enroll/status", cookie);

    return yield* Schema.decodeUnknownEffect(EnrollmentStatus)(
      yield* Effect.promise(() => response.json()),
    );
  });

  return {
    h,
    account,
    binding,
    admissions,
    callbackEntered,
    app,
    request,
    begin,
    complete,
    status,
  };
});

const privateHeaders = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
};

const grant = (h: Effect.Success<ReturnType<typeof harness>>) => {
  h.control.grantUser = "400";
  h.control.grantLogin = "public_channel";
  h.control.grantScopes = ["channel:bot"];
};

test(
  "raw HTTP enrollment reaches ready only after durable alarm repair and signed confirmed observation",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      yield* f.h.authorize(f.account.service);
      const before = Schema.decodeUnknownSync(AccountState)(f.h.snapshot());
      const begun = yield* f.begin();
      privateHeaders(begun.response);
      expect(begun.location.origin).toBe("https://id.twitch.tv");
      expect(begun.location.searchParams.get("redirect_uri")).toBe(
        `${origin}/oauth/twitch/callback`,
      );
      expect(begun.location.searchParams.get("scope")).toBe("channel:bot");
      expect(begun.state).toMatch(/^enroll\.[a-f0-9]{64}$/);
      expect(begun.cookie).toMatch(/^__Host-arctools-enrollment=[a-f0-9]{64}$/);
      const browserCredential = begun.cookie.split("=")[1];
      expect(begun.state).not.toBe(`enroll.${browserCredential}`);
      expect(begun.response.headers.get("set-cookie")).toContain(
        "Path=/; Secure; HttpOnly; SameSite=Lax",
      );
      expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });
      grant(f.h);
      const completed = yield* f.complete(begun.state, begun.cookie);
      expect(completed.status).toBe(303);
      expect(completed.headers.get("location")).toBe("/connect");
      privateHeaders(completed);
      expect(yield* Effect.promise(() => completed.text())).toBe("");
      expect(f.h.nativeAlarmAt()).toBe(initial + 1);
      expect(
        Schema.decodeUnknownSync(AccountState)(f.h.snapshot()).sender,
      ).toEqual(before.sender);
      f.h.control.subscriptionStatus = "webhook_callback_verification_pending";
      const recovered = yield* f.h.construct("revision-one", f.binding);
      f.h.time(initial + 1);
      f.h.consumeAlarm();
      yield* recovered.credentialAlarm();
      expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });

      const record = Schema.decodeUnknownSync(AccountState)(f.h.snapshot())
        .subscriptions["400"];

      if (!record)
        return yield* Effect.die("Alarm did not persist subscription proof");
      const event = twitchEvent("public-command", "!sell sensors", callback);

      const notification = {
        ...event,
        subscription: {
          ...event.subscription,
          id: record.id,
          condition: { broadcaster_user_id: "400", user_id: "100" },
        },
        event: {
          ...event.event,
          broadcaster_user_id: "400",
          broadcaster_user_login: "public_channel",
          chatter_user_id: "500",
        },
      };

      const challengeBody = new TextEncoder().encode(
        JSON.stringify({
          subscription: {
            ...notification.subscription,
            status: "webhook_callback_verification_pending",
          },
          challenge: "controlled-challenge",
        }),
      );

      const challengeHeaders = yield* signTwitch(
        challengeBody,
        "public-challenge",
        initial + 1,
        "webhook_callback_verification",
      );

      const challenge = yield* Effect.promise(() =>
        f.app.handler(
          new Request(`${origin}/webhooks/twitch`, {
            method: "POST",
            body: challengeBody,
            headers: challengeHeaders,
          }),
        ),
      );

      expect(challenge.status).toBe(200);
      expect(yield* Effect.promise(() => challenge.text())).toBe(
        "controlled-challenge",
      );
      expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });
      expect(f.admissions).toEqual([]);

      const body = new TextEncoder().encode(JSON.stringify(notification));

      const signed = yield* signTwitch(
        body,
        "public-delivery",
        initial + 1,
        "notification",
      );

      const observed = yield* Effect.promise(() =>
        f.app.handler(
          new Request(`${origin}/webhooks/twitch`, {
            method: "POST",
            body,
            headers: signed,
          }),
        ),
      );

      expect(observed.status).toBe(204);
      expect(f.admissions).toEqual(["400"]);
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      const unrelated = yield* f.begin();
      expect(yield* f.status(unrelated.cookie)).toEqual({ kind: "pending" });
      const exchanges = f.h.control.exchanges;
      expect((yield* f.complete(begun.state, begun.cookie)).status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges);
      const snapshot = JSON.stringify(f.h.snapshot());
      expect(snapshot).not.toContain("canary-user-token");
      expect(snapshot).not.toContain(begun.state);
      expect(snapshot).not.toContain(
        browserCredential ?? "missing-browser-credential",
      );
    }).pipe(Effect.provideService(Clock.Clock, f.h.clock));
  }),
);

test(
  "raw callbacks bind cookie and nonce before denial, reject bounded malformed input, and keep operator namespace independent",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      yield* f.h.authorize(f.account.service);
      const begun = yield* f.begin();
      const other = yield* f.begin();
      const exchanges = f.h.control.exchanges;

      const pending = Schema.decodeUnknownSync(AccountState)(
        f.h.snapshot(),
      ).enrollments;

      const denial = `/oauth/twitch/callback?state=${begun.state}&error=access_denied`;

      for (const [path, cookie] of [
        [denial, ""],
        [
          `/oauth/twitch/callback?state=${begun.state.slice(7)}&code=controlled`,
          begun.cookie,
        ],
        [denial, other.cookie],
        [`${denial}&state=${other.state}`, begun.cookie],
        [`${denial}&code=ambiguous`, begun.cookie],
        [
          `/oauth/twitch/callback?state=${begun.state}&code=${"x".repeat(2049)}`,
          begun.cookie,
        ],
        [
          `/oauth/twitch/callback?state=${begun.state}&code=a&code=b`,
          begun.cookie,
        ],
        [`${denial}&cookie=${encodeURIComponent(begun.cookie)}`, ""],
        [denial, `${begun.cookie}; ${begun.cookie}`],
        [denial, `${enrollmentCookie}=%61${"a".repeat(63)}`],
        [denial, `oversized=${"a".repeat(4097)}`],
      ]) {
        const response = yield* f.request(path ?? "", cookie);
        expect(response.status).toBe(400);
        privateHeaders(response);
        expect([
          '{"error":"authorization-failed"}',
          '{"error":"invalid-callback"}',
        ]).toContain(yield* Effect.promise(() => response.text()));
      }

      expect(f.h.control.exchanges).toBe(exchanges);
      expect(
        Schema.decodeUnknownSync(AccountState)(f.h.snapshot()).enrollments,
      ).toEqual(pending);
      const denied = yield* f.request(denial, begun.cookie);
      expect(denied.status).toBe(303);
      expect(denied.headers.get("location")).toBe("/connect");
      expect(yield* Effect.promise(() => denied.text())).toBe("");
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "failed",
        reason: "denied",
      });
      expect((yield* f.request(denial, begun.cookie)).status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges);

      const noCookie = yield* f.request(
        `/oauth/twitch/enroll/status?cookie=${encodeURIComponent(other.cookie)}`,
      );

      expect(noCookie.status).toBe(401);
      privateHeaders(noCookie);
      const expired = yield* f.begin();
      f.h.time(initial + 600_000);
      expect((yield* f.complete(expired.state, expired.cookie)).status).toBe(
        400,
      );
      expect(f.h.control.exchanges).toBe(exchanges);
    }).pipe(Effect.provideService(Clock.Clock, f.h.clock));
  }),
);

test(
  "operator callback works with unrelated valid or malformed enrollment cookies and public state never enters operator completion",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const setup = yield* f.account.service.setup(yield* digest("operator"));

      for (const [index, auth] of setup.authorizations.entries()) {
        const state = new URL(auth.url).searchParams.get("state") ?? "";
        f.h.control.grantLogin = auth.login;
        f.h.control.grantUser = Match.value(auth.login).pipe(
          Match.when("fixture_sender", () => "100"),
          Match.when("fixture_channel", () => "200"),
          Match.orElse(() => "300"),
        );
        f.h.control.grantScopes =
          new URL(auth.url).searchParams.get("scope")?.split(" ") ?? [];

        const cookie =
          index === 0
            ? `${enrollmentCookie}=malformed`
            : `${enrollmentCookie}=${"a".repeat(64)}`;

        const response = yield* f.complete(state, cookie);
        expect(response.status).toBe(200);
        privateHeaders(response);
        expect(yield* Effect.promise(() => response.text())).toContain(
          "Authorization recorded",
        );
      }

      const status = yield* f.account.service.status();
      expect(Schema.is(AccountStatus)(status)).toBeTrue();
      expect(status.sender?.authorized).toBeTrue();
      const begun = yield* f.begin();
      const exchanges = f.h.control.exchanges;

      const rejected = yield* f.request(
        `/oauth/twitch/callback?state=${begun.state}&code=controlled`,
      );

      expect(rejected.status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges);
      expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });
    }).pipe(Effect.provideService(Clock.Clock, f.h.clock));
  }),
);

test(
  "raw begin is unavailable before sender authorization and never allocates a browser session",
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = f.h.snapshot();
    const response = yield* f.request("/oauth/twitch/enroll");
    expect(response.status).toBe(503);
    privateHeaders(response);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(yield* Effect.promise(() => response.json())).toEqual({
      error: "enrollment-unavailable",
    });
    expect(f.h.snapshot()).toEqual(before);
    expect(f.h.control.exchanges).toBe(0);
  }),
);

test(
  "the public HTTP callback allows slow valid provider calls plus queue time beyond the operator callback deadline",
  Effect.gen(function* () {
    const f = yield* fixture(600);
    yield* f.h
      .authorize(f.account.service)
      .pipe(Effect.provideService(Clock.Clock, f.h.clock));
    const begun = yield* f.begin();
    grant(f.h);
    f.h.control.sleepProviderDelays = true;
    f.h.control.exchangeElapsedMs = 3_900;
    f.h.control.grantValidationElapsedMs = 3_900;
    f.h.control.usersElapsedMs = 3_900;
    const exchanges = f.h.control.exchanges;
    const validations = f.h.control.validations;
    const users = f.h.control.usersTokens.length;

    const completion = yield* f
      .complete(begun.state, begun.cookie)
      .pipe(Effect.forkChild);

    yield* Deferred.await(f.callbackEntered);
    yield* TestClock.adjust(600);

    for (let i = 0; i < 1000 && f.h.control.exchanges === exchanges; i++)
      yield* Effect.yieldNow;
    expect(f.h.control.exchanges).toBe(exchanges + 1);
    yield* TestClock.adjust(3_900);

    for (let i = 0; i < 1000 && f.h.control.validations === validations; i++)
      yield* Effect.yieldNow;
    expect(f.h.control.validations).toBe(validations + 1);
    yield* TestClock.adjust(3_900);

    for (let i = 0; i < 1000 && f.h.control.usersTokens.length === users; i++)
      yield* Effect.yieldNow;
    expect(f.h.control.usersTokens.length).toBe(users + 1);
    yield* TestClock.adjust(3_900);
    const response = yield* Fiber.join(completion);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/connect");
    expect(yield* Effect.promise(() => response.text())).toBe("");
    expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });
    const state = Schema.decodeUnknownSync(AccountState)(f.h.snapshot());
    expect(state.grants["400"]).toEqual(["channel:bot"]);
    expect(state.publicMembers.map((member) => String(member.id))).toEqual([
      "400",
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "operator setup maps account capacity to an actionable conflict response",
  Effect.gen(function* () {
    const f = yield* fixture(0, true);

    const response = yield* Effect.promise(() =>
      f.app.handler(
        new Request(`${origin}/ops/setup`, {
          method: "POST",
          headers: {
            authorization: "Bearer operator",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stage: "prod" }),
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      error: "channel-capacity-exceeded",
    });
    privateHeaders(response);
  }),
);
