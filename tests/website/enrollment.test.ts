import { expect } from "bun:test";

import {
  AccountStatus,
  AccountError,
  EnrollmentStatus,
  TwitchAccount,
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

import { BotApi } from "../../apps/bot/src/api.js";
import { EnvironmentConfig } from "../../apps/bot/src/config.js";
import { ingressHandlers } from "../../apps/bot/src/ingress.js";
import { operatorHandlers } from "../../apps/bot/src/operator.js";
import { discordResponse } from "../../apps/bot/src/presentation.js";
import { botOperations } from "../../apps/bot/src/rpc.js";
import { Tenants } from "../../apps/bot/src/tenant-contracts.js";
import {
  enrollmentCookie,
  enrollmentHead,
  localEnrollmentCookie,
  websiteHttp,
} from "../../apps/website/src/server/enrollment.js";
import {
  discordPublicKey,
  signTwitch,
  twitchEvent,
} from "../cloud/signatures.js";

const { test } = Test.make({ providers: Layer.empty });

const origin = "https://fixture.invalid";

const callback = `${origin}/webhooks/twitch`;

const identity = Schema.decodeUnknownSync(EnvironmentConfig)({
  ...fixtureConfig,
  kind: "bot",
  stage: "local-enrollment",
  applicationStage: "local-enrollment",
  twitchClientId: "independent-test-application",
  senderKind: "bot",
  discordApplicationId: "controlled-discord",
});

const fixture = Effect.fnUntraced(function* (
  enrollmentDelayMs = 0,
  setupCapacity = false,
  websiteOrigin = "https://website.fixture.invalid",
) {
  const h = yield* harness(identity);

  const binding = yield* subscriptionBinding({
    callback,
    clientId: identity.twitchClientId,
    signingSecret: Redacted.make("fixture-signing"),
  });

  const account = yield* h.construct(
    "revision-one",
    binding,
    identity,
    websiteOrigin,
  );

  const admissions: string[] = [];
  const callbackEntered = yield* Deferred.make<void>();

  const handlers = HttpApiBuilder.layer(BotApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(BotApi, "health", (handlers) =>
        handlers.handle("health", () =>
          Effect.succeed({
            status: "ready",
            stage: identity.stage,
            revision: "controlled",
            manifestHash: "controlled",
          }),
        ),
      ),
    ),
    Layer.provide(operatorHandlers(identity.stage, Redacted.make("operator"))),
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

  const http = websiteHttp(
    Effect.succeed(
      botOperations({
        account: Effect.succeed(account.service),
        enrollment: Effect.succeed({
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
        operatorSecret: Redacted.make("operator"),
      }),
    ),
    Effect.succeed(websiteOrigin),
  );

  const request = (path: string, cookie?: string, method = "GET") => {
    const incoming = new Request(`${websiteOrigin}${path}`, {
      method,
      headers: cookie ? { cookie } : undefined,
    });

    if (method === "HEAD") return Effect.succeed(enrollmentHead());

    switch (new URL(incoming.url).pathname) {
      case "/oauth/twitch/enroll":
        return http.begin(incoming);
      case "/oauth/twitch/enroll/status":
        return http.status(incoming);
      case "/oauth/twitch/callback":
        return http.callback(incoming);
      default:
        return Effect.succeed(new Response(null, { status: 404 }));
    }
  };

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
    http,
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
        "https://website.fixture.invalid/oauth/twitch/callback",
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

      const recovered = yield* f.h.construct(
        "revision-one",
        f.binding,
        identity,
        "https://website.fixture.invalid",
      );

      f.h.time(initial + 1);
      f.h.consumeAlarm();
      yield* recovered.credentialAlarm();
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "recovering",
        login: "public_channel",
      });

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
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "recovering",
        login: "public_channel",
      });
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

      const selfBody = new TextEncoder().encode(
        JSON.stringify({
          ...notification,
          event: {
            ...notification.event,
            message_id: "self-command",
            chatter_user_id: "100",
          },
        }),
      );

      const selfHeaders = yield* signTwitch(
        selfBody,
        "self-delivery",
        initial + 1,
        "notification",
      );

      const selfResponse = yield* Effect.promise(() =>
        f.app.handler(
          new Request(`${origin}/webhooks/twitch`, {
            method: "POST",
            body: selfBody,
            headers: selfHeaders,
          }),
        ),
      );

      expect(selfResponse.status).toBe(204);
      expect(f.admissions).toEqual(["400"]);
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

for (const websiteOrigin of [
  "https://website.fixture.invalid",
  "http://localhost:3000",
]) {
  test(
    `operator callback at ${websiteOrigin} ignores enrollment cookies and public state never enters operator completion`,
    Effect.gen(function* () {
      const f = yield* fixture(0, false, websiteOrigin);
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

          const cookie = Match.value(index).pipe(
            Match.when(0, () => ""),
            Match.when(1, () => `${enrollmentCookie}=malformed`),
            Match.orElse(() => `${enrollmentCookie}=${"a".repeat(64)}`),
          );

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
}

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
    expect(yield* f.status(begun.cookie)).toEqual({
      kind: "recovering",
      login: "public_channel",
    });
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
          body: JSON.stringify({ stage: identity.stage }),
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

test(
  "Website HEAD never creates an intent and Bot rejects removed browser endpoints",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.h
      .authorize(f.account.service)
      .pipe(Effect.provideService(Clock.Clock, f.h.clock));
    const before = f.h.snapshot();

    for (const path of [
      "/oauth/twitch/enroll",
      "/oauth/twitch/enroll/status",
      "/oauth/twitch/callback",
    ]) {
      const response = yield* f.request(path, undefined, "HEAD");
      expect(response.status).toBe(405);
      expect(response.headers.get("set-cookie")).toBeNull();
      privateHeaders(response);

      const botResponse = yield* Effect.promise(() =>
        f.app.handler(new Request(`${origin}${path}`)),
      );

      expect(botResponse.status).toBe(404);
    }

    expect(f.h.snapshot()).toEqual(before);
  }),
);

test(
  "localhost HTTP enrollment completes with its own HttpOnly cookie and preserves denial and replay fencing",
  Effect.gen(function* () {
    const f = yield* fixture(0, false, "http://localhost:3000");
    yield* Effect.gen(function* () {
      yield* f.h.authorize(f.account.service);
      const begun = yield* f.begin();
      expect(begun.location.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/oauth/twitch/callback",
      );
      expect(begun.cookie).toMatch(/^arctools-enrollment-local=[a-f0-9]{64}$/);
      const flags = begun.response.headers.get("set-cookie") ?? "";
      expect(flags).toContain("Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
      expect(flags).not.toContain("Secure");
      expect(flags).not.toContain("Domain=");
      expect(yield* f.status(begun.cookie)).toEqual({ kind: "pending" });
      const other = yield* f.begin();
      const exchanges = f.h.control.exchanges;
      expect((yield* f.complete(begun.state, other.cookie)).status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges);
      grant(f.h);
      expect((yield* f.complete(begun.state, begun.cookie)).status).toBe(303);
      expect(f.h.control.exchanges).toBe(exchanges + 1);
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "recovering",
        login: "public_channel",
      });
      expect((yield* f.complete(begun.state, begun.cookie)).status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges + 1);
      const denied = yield* f.begin();
      const denial = `/oauth/twitch/callback?state=${denied.state}&error=access_denied`;
      expect((yield* f.request(denial, other.cookie)).status).toBe(400);
      expect((yield* f.request(denial, denied.cookie)).status).toBe(303);
      expect(yield* f.status(denied.cookie)).toEqual({
        kind: "failed",
        reason: "denied",
      });
      expect((yield* f.request(denial, denied.cookie)).status).toBe(400);
      expect(f.h.control.exchanges).toBe(exchanges + 1);
    }).pipe(Effect.provideService(Clock.Clock, f.h.clock));
  }),
);

test(
  "local enrollment cookies never authorize HTTPS or other HTTP origins and HTTPS cookies never authorize HTTP localhost",
  Effect.gen(function* () {
    const f = yield* fixture(0, false, "http://localhost:3000");
    yield* f.h
      .authorize(f.account.service)
      .pipe(Effect.provideService(Clock.Clock, f.h.clock));
    const local = yield* f.begin();

    for (const origin of [
      "https://website.fixture.invalid",
      "https://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://remote.invalid:3000",
    ]) {
      const response = yield* f.http.status(
        new Request(`${origin}/oauth/twitch/enroll/status`, {
          headers: { cookie: local.cookie },
        }),
      );

      expect(response.status).toBe(401);
      privateHeaders(response);
    }

    const secure = `${enrollmentCookie}=${local.cookie.slice(localEnrollmentCookie.length + 1)}`;
    expect(
      (yield* f.request("/oauth/twitch/enroll/status", secure)).status,
    ).toBe(401);
    const before = f.h.snapshot();

    for (const origin of [
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://remote.invalid:3000",
    ]) {
      const response = yield* f.http.begin(
        new Request(`${origin}/oauth/twitch/enroll`, {
          headers: { cookie: local.cookie },
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    expect(f.h.snapshot()).toEqual(before);
  }),
);

for (const origin of [
  "http://remote.invalid",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://localhost",
  "http://user@localhost:3000",
  "http://localhost:3000?x=1",
  "http://localhost:3000#fragment",
  "http://localhost:3000/other",
]) {
  test(
    `account rejects noncanonical HTTP OAuth redirect origin ${origin}`,
    Effect.gen(function* () {
      const f = yield* fixture(0, false, origin);

      const error = yield* f.account.service
        .setup("operator-digest")
        .pipe(Effect.flip);

      expect(error.code).toBe("configuration");
    }),
  );
}

test(
  "same-origin Leave crosses the real Bot/account boundary and lost response replays without extending expiry",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      yield* f.h.authorize(f.account.service);
      const begun = yield* f.begin();
      grant(f.h);
      yield* f.complete(begun.state, begun.cookie);
      f.h.time(initial + 1);
      yield* f.account.credentialAlarm();
      const before = f.h.snapshot();

      const request = () =>
        new Request(
          "https://website.fixture.invalid/oauth/twitch/enroll/leave",
          {
            method: "POST",
            headers: {
              cookie: begun.cookie,
              origin: "https://website.fixture.invalid",
            },
          },
        );

      const lost = yield* f.http.leave(request());
      expect(lost.status).toBe(200);
      expect(lost.headers.get("set-cookie")).toBeNull();
      expect(yield* Effect.promise(() => lost.json())).toEqual({
        kind: "left",
        login: "public_channel",
      });

      const restored = yield* f.h.construct(
        "revision-one",
        f.binding,
        identity,
        "https://website.fixture.invalid",
      );

      const replayHttp = websiteHttp(
        Effect.succeed(
          botOperations({
            account: Effect.succeed(restored.service),
            enrollment: Effect.succeed(restored.enrollment),
            operatorSecret: Redacted.make("operator"),
          }),
        ),
        Effect.succeed("https://website.fixture.invalid"),
      );

      const replay = yield* replayHttp.leave(request());
      expect(replay.status).toBe(200);
      expect(yield* Effect.promise(() => replay.json())).toEqual({
        kind: "left",
        login: "public_channel",
      });
      expect(yield* f.status(begun.cookie)).toEqual({
        kind: "left",
        login: "public_channel",
      });
      expect(f.h.snapshot().enrollments[0]?.expiresAt).toBe(
        before.enrollments[0]?.expiresAt,
      );
      expect(f.h.snapshot().grants["100"]).toEqual(before.grants["100"]);
    }).pipe(Effect.provideService(Clock.Clock, f.h.clock));
  }).pipe(Effect.scoped),
);

for (const originHeader of [
  null,
  "null",
  "https://foreign.invalid",
  "https://website.fixture.invalid:444",
  "https://website.fixture.invalid/",
  "https://website.fixture.invalid, https://foreign.invalid",
])
  test(
    `Leave rejects Origin ${originHeader} before Bot`,
    Effect.gen(function* () {
      let calls = 0;

      const http = websiteHttp(
        Effect.sync(() => {
          calls++;
          throw new Error("Bot must not be selected");
        }),
        Effect.succeed("https://website.fixture.invalid"),
      );

      const request = new Request(
        "https://website.fixture.invalid/oauth/twitch/enroll/leave",
        {
          method: "POST",
          headers: originHeader === null ? {} : { origin: originHeader },
        },
      );

      expect((yield* http.leave(request)).status).toBe(403);
      expect(calls).toBe(0);
    }),
  );

for (const method of ["GET", "HEAD", "PUT", "OPTIONS"])
  test(
    `Leave ${method} requires POST before Bot`,
    Effect.gen(function* () {
      const http = websiteHttp(Effect.die("Bot must not be selected"));

      const response = yield* http.leave(
        new Request(
          "https://website.fixture.invalid/oauth/twitch/enroll/leave",
          { method },
        ),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }),
  );

test(
  "Leave rejects target bodies, query parameters, mismatched deployment, cross-site metadata and missing cookies",
  Effect.gen(function* () {
    const http = websiteHttp(
      Effect.die("Bot must not be selected"),
      Effect.succeed("https://website.fixture.invalid"),
    );

    for (const [suffix, headers, body, expected] of [
      [
        "",
        { origin: "https://website.fixture.invalid" },
        '{"broadcasterId":"500"}',
        400,
      ],
      ["?target=500", { origin: "https://website.fixture.invalid" }, "", 400],
      [
        "",
        {
          origin: "https://website.fixture.invalid",
          "sec-fetch-site": "cross-site",
        },
        "",
        403,
      ],
      ["", { origin: "https://website.fixture.invalid" }, "", 401],
    ] as const) {
      const response = yield* http.leave(
        new Request(
          `https://website.fixture.invalid/oauth/twitch/enroll/leave${suffix}`,
          { method: "POST", headers, body },
        ),
      );

      expect(response.status).toBe(expected);
    }

    expect(
      (yield* http.leave(
        new Request("https://different.invalid/oauth/twitch/enroll/leave", {
          method: "POST",
          headers: { origin: "https://different.invalid" },
        }),
      )).status,
    ).toBe(403);
  }),
);
