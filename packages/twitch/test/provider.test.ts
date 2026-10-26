import { expect } from "bun:test";

import { Dispatch } from "@arctools/twitch/server";
import { makeProvider, type SendResult } from "@arctools/twitch/testing";
import { providerTransport } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import {
  Predicate,
  Cause,
  Clock,
  Deferred,
  Fiber,
  Effect,
  Layer,
  Match,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

const { test } = Test.make({ providers: Layer.empty });

const fixture = Effect.fnUntraced(function* () {
  const control = {
    status: 200,
    body: JSON.stringify({ data: [{ is_sent: true, message_id: "message" }] }),
    sends: 0,
    pages: 0,
    sourceOnly: false,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/chat/messages") {
        control.sends++;

        const input = Schema.decodeUnknownSync(
          Schema.Struct({ for_source_only: Schema.Boolean }),
        )(await request.json());

        control.sourceOnly = input.for_source_only;

        return new Response(control.body, {
          status: control.status,
          headers: {
            "Content-Type": "application/json",
            "Ratelimit-Reset": "1000000002",
          },
        });
      }

      if (url.pathname === "/eventsub/subscriptions") {
        control.pages++;
        const next = url.searchParams.get("after");

        return Response.json({
          data: [
            {
              id: next ? "second" : "first",
              status: "enabled",
              type: "channel.chat.message",
              version: "1",
              condition: {
                broadcaster_user_id: next ? "300" : "200",
                user_id: "100",
              },
              transport: {
                method: "webhook",
                callback: "https://callback.invalid/webhooks/twitch",
              },
            },
          ],
          pagination: next ? {} : { cursor: "cursor-two" },
        });
      }

      return new Response("canary-body-secret", { status: 500 });
    },
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
  const base = `http://127.0.0.1:${server.port}`;

  const provider = yield* makeProvider(
    {
      clientId: "fixture-twitch",
      clientSecret: Redacted.make("canary-client-secret"),
      signingSecret: Redacted.make("canary-signing-secret"),
      callback: "https://callback.invalid/webhooks/twitch",
      redirect: "https://callback.invalid/oauth/twitch/callback",
    },
    { api: base, oauth: base },
  ).pipe(Effect.provide(providerTransport));

  const now = yield* Clock.currentTimeMillis;

  const input = Schema.decodeUnknownSync(Dispatch)({
    source: {
      installationId: "provider-fixture",
      subscriptionId: "provider-fixture",
    },
    attemptId: "attempt",
    broadcasterId: "200",
    replyParentId: "reply",
    text: "Sensors",
    deadline: now + 10_000,
  });

  return { control, provider, input };
});

test(
  "Helix checks is_sent and never treats malformed or unknown POST responses as retryable",
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.provider.send("canary-app-token", "100", f.input)).toEqual({
      kind: "sent",
      messageId: "message",
    });
    expect(f.control.sourceOnly).toBeTrue();
    f.control.body = JSON.stringify({
      data: [
        {
          is_sent: false,
          message_id: "",
          drop_reason: { code: "automod", message: "canary-private-drop" },
        },
      ],
    });
    expect(yield* f.provider.send("canary-app-token", "100", f.input)).toEqual({
      kind: "rejected",
      code: "automod",
    });
    f.control.body = "malformed canary-body";
    expect(yield* f.provider.send("canary-app-token", "100", f.input)).toEqual({
      kind: "ambiguous",
    });
    f.control.status = 500;
    expect(yield* f.provider.send("canary-app-token", "100", f.input)).toEqual({
      kind: "ambiguous",
    });
  }),
);

test(
  "Helix explicit 401/429 outcomes are distinct from failed message creation and expiry starts no POST",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.status = 401;
    f.control.body = "{}";
    expect(yield* f.provider.send("canary-app-token", "100", f.input)).toEqual({
      kind: "unauthorized",
    });
    f.control.status = 429;
    expect(
      (yield* f.provider.send("canary-app-token", "100", f.input)).kind,
    ).toBe("limited");
    const now = yield* Clock.currentTimeMillis;

    const input = Schema.decodeUnknownSync(Dispatch)({
      ...f.input,
      deadline: now,
    });

    expect(yield* f.provider.send("canary-app-token", "100", input)).toEqual({
      kind: "expired",
    });
    expect(f.control.sends).toBe(2);
  }),
);

test(
  "EventSub consumes every cursor page and HTTP failures discard request secrets and raw bodies",
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      (yield* f.provider.list("canary-app-token")).map((sub) => sub.id),
    ).toEqual(["first", "second"]);
    expect(f.control.pages).toBe(2);

    const failure = yield* f.provider
      .exchange("canary-oauth-code")
      .pipe(Effect.exit);

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("canary");

    if (Predicate.isTagged(failure, "Failure"))
      expect(Cause.pretty(failure.cause)).not.toContain("canary");
  }),
);

const nativeConfig = {
  clientId: "native-client",
  clientSecret: Redacted.make("native-client-secret"),
  signingSecret: Redacted.make("native-signing-secret"),
  callback: "https://bot.invalid/webhooks/twitch",
  redirect: "https://website.invalid/oauth/twitch/callback",
};

const nativeFixture = Effect.fnUntraced(function* (
  respond: (request: HttpClientRequest.HttpClientRequest, url: URL) => Response,
  config = nativeConfig,
) {
  const requests: {
    request: HttpClientRequest.HttpClientRequest;
    url: URL;
    response: Response;
  }[] = [];

  const client = HttpClient.make((request, url) => {
    const response = respond(request, url);
    requests.push({ request, url, response });

    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  const provider = yield* makeProvider(config).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );

  const now = yield* Clock.currentTimeMillis;

  const input = Schema.decodeUnknownSync(Dispatch)({
    source: {
      installationId: "provider-fixture",
      subscriptionId: "provider-fixture",
    },
    attemptId: "native-attempt",
    broadcasterId: "200",
    replyParentId: "reply",
    text: "Sensors",
    deadline: now + 10_000,
  });

  return { requests, provider, input };
});

const nativeSubscription = {
  id: "subscription",
  status: "enabled",
  type: "channel.chat.message",
  version: "1",
  condition: { broadcaster_user_id: "200", user_id: "100" },
  transport: {
    method: "webhook",
    callback: "https://bot.invalid/webhooks/twitch",
  },
};

test(
  "EventSub Retry-After parses delta seconds exclusively and still accepts HTTP dates",
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const until = Math.floor((now + 3_600_000) / 1000) * 1000;

    for (const [header, expected] of [
      ["3600", now + 3_600_000],
      [new Date(until).toUTCString(), until],
    ] as const) {
      const f = yield* nativeFixture(
        () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": header },
          }),
      );

      const error = yield* f.provider.list("token").pipe(Effect.flip);

      expect(error.retryAt).toBe(expected);
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "native clients capture transport while each method uses the current token and its own authorization scheme",
  Effect.gen(function* () {
    const f = yield* nativeFixture((request, url) => {
      if (url.pathname === "/oauth2/token")
        return Response.json({
          access_token: "minted",
          expires_in: 3600,
          token_type: "bearer",
        });

      if (url.pathname === "/oauth2/validate")
        return Response.json({
          client_id: "native-client",
          expires_in: 3600,
          scopes: [],
        });

      if (url.pathname === "/helix/users")
        return Response.json({ data: [{ id: "100", login: "sender" }] });

      if (url.pathname === "/helix/chat/messages")
        return Response.json({ data: [{ is_sent: true, message_id: "sent" }] });

      if (request.method === "DELETE")
        return new Response(null, { status: 204 });

      return Response.json(
        { data: [nativeSubscription] },
        { status: request.method === "POST" ? 202 : 200 },
      );
    });

    for (const token of ["first-token", "rotated-token"]) {
      yield* f.provider.validate(token);
      yield* f.provider.users(token, ["sender", "channel"]);
      yield* f.provider.list(token);
      expect((yield* f.provider.create(token, "200", "100")).kind).toBe(
        "created",
      );
      yield* f.provider.remove(token, "subscription");
      expect((yield* f.provider.send(token, "100", f.input)).kind).toBe("sent");
    }

    expect(
      f.requests.map(({ request }) => request.headers.authorization),
    ).toEqual(
      ["first-token", "rotated-token"].flatMap((token) => [
        `OAuth ${token}`,
        ...Array<string>(5).fill(`Bearer ${token}`),
      ]),
    );
    expect(
      f.requests
        .filter(({ url }) => url.pathname.startsWith("/helix/"))
        .every(
          ({ request }) => request.headers["client-id"] === "native-client",
        ),
    ).toBeTrue();
    expect(
      f.requests
        .filter(({ url }) => url.pathname === "/helix/users")
        .map(({ url }) => url.searchParams.getAll("login")),
    ).toEqual([
      ["sender", "channel"],
      ["sender", "channel"],
    ]);
    yield* f.provider.mint();
    yield* f.provider.exchange("authorization-code");

    for (const { request, url } of f.requests.slice(-2)) {
      expect(url.origin).toBe("https://id.twitch.tv");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["client-id"]).toBeUndefined();
      expect(request.body._tag).toBe("Uint8Array");

      if (Predicate.isTagged(request.body, "Uint8Array")) {
        const params = new URLSearchParams(
          new TextDecoder().decode(request.body.body),
        );

        expect(params.get("client_id")).toBe("native-client");
        expect(params.get("client_secret")).toBe("native-client-secret");

        if (params.get("grant_type") === "authorization_code")
          expect(params.get("redirect_uri")).toBe(
            "https://website.invalid/oauth/twitch/callback",
          );
      }
    }

    expect(f.requests).toHaveLength(14);
  }),
);

test(
  "native status policies preserve create conflicts, accepted removals and ignored error bodies",
  Effect.gen(function* () {
    let status = 409;

    const f = yield* nativeFixture(
      () => new Response(status === 204 ? null : "{canary-invalid", { status }),
    );

    expect(yield* f.provider.create("token", "200", "100")).toEqual({
      kind: "conflict",
    });
    expect(f.requests.at(-1)?.response.bodyUsed).toBeFalse();
    status = 401;
    expect(
      (yield* f.provider.create("token", "200", "100").pipe(Effect.flip)).code,
    ).toBe("client");
    expect(f.requests.at(-1)?.response.bodyUsed).toBeFalse();
    status = 202;
    expect(yield* f.provider.create("token", "200", "100")).toEqual({
      kind: "unknown",
    });
    expect(f.requests.at(-1)?.response.bodyUsed).toBeTrue();

    for (const next of [204, 404]) {
      status = next;
      yield* f.provider.remove("token", "subscription");
    }

    status = 200;
    expect(
      (yield* f.provider.remove("token", "subscription").pipe(Effect.flip))
        .code,
    ).toBe("provider");
    expect(f.requests.at(-1)?.response.bodyUsed).toBeTrue();
    status = 429;
    expect((yield* f.provider.users("token", []).pipe(Effect.flip)).code).toBe(
      "provider",
    );
    expect(f.requests.at(-1)?.response.bodyUsed).toBeFalse();
  }),
);

test(
  "native send status and rate-limit headers preserve budgets, fallbacks and malformed-body outcomes without replay",
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let status = 200;

    let body = JSON.stringify({
      data: [{ is_sent: true, message_id: "sent" }],
    });

    const headers = new Headers({
      "Ratelimit-Remaining": "0",
      "Ratelimit-Reset": String((now + 2000) / 1000),
    });

    const f = yield* nativeFixture(
      () => new Response(body, { status, headers }),
    );

    expect(yield* f.provider.send("token", "100", f.input)).toEqual({
      kind: "sent",
      messageId: "sent",
      blockedUntil: now + 2000,
    });
    body = "{";

    for (const next of [401, 400, 403, 422, 500]) {
      status = next;
      expect(yield* f.provider.send("token", "100", f.input)).toEqual(
        Match.value(next).pipe(
          Match.when(401, (): SendResult => ({
            kind: "unauthorized",
            blockedUntil: now + 2000,
          })),
          Match.when(500, (): SendResult => ({ kind: "ambiguous" })),
          Match.orElse((): SendResult => ({
            kind: "rejected",
            code: `http-${next}`,
            blockedUntil: now + 2000,
          })),
        ),
      );
      expect(f.requests.at(-1)?.response.bodyUsed).toBeFalse();
    }

    for (const next of [200, 201, 429]) {
      status = next;
      expect(yield* f.provider.send("token", "100", f.input)).toEqual({
        kind: "ambiguous",
      });
      expect(f.requests.at(-1)?.response.bodyUsed).toBeTrue();
    }

    status = 429;
    body = "{}";
    expect(yield* f.provider.send("token", "100", f.input)).toEqual({
      kind: "limited",
      retryAt: now + 2000,
    });

    for (const reset of [undefined, "bad", "Infinity", "-1", "0"]) {
      if (reset === undefined) headers.delete("Ratelimit-Reset");
      else headers.set("Ratelimit-Reset", reset);
      expect(yield* f.provider.send("token", "100", f.input)).toEqual({
        kind: "limited",
        retryAt: now + 1000,
      });
    }

    headers.set("Ratelimit-Reset", String((now + 2000) / 1000));
    headers.set("Ratelimit-Remaining", "1");
    status = 200;
    body = JSON.stringify({ data: [{ is_sent: false, message_id: "" }] });
    expect(yield* f.provider.send("token", "100", f.input)).toEqual({
      kind: "rejected",
      code: "dropped",
    });
    expect(f.requests).toHaveLength(16);
    expect(
      yield* f.provider.send("token", "100", {
        ...f.input,
        deadline: Dispatch.fields.deadline.make(now),
      }),
    ).toEqual({ kind: "expired" });
    expect(f.requests).toHaveLength(16);
  }).pipe(Effect.provide(TestClock.layer())),
);

for (const remaining of [250, 8000])
  test(
    `native send with ${remaining}ms remaining aborts at the deadline or the 4-second cap without replay`,
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const aborted: number[] = [];
      let attempts = 0;

      const client = HttpClient.make((_request, _url, signal) =>
        Effect.gen(function* () {
          attempts++;
          const clock = yield* Clock.Clock;
          signal.addEventListener(
            "abort",
            () => aborted.push(clock.currentTimeMillisUnsafe()),
            { once: true },
          );
          yield* Deferred.succeed(entered, undefined);

          return yield* Effect.never;
        }),
      );

      const provider = yield* makeProvider(nativeConfig).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const input = Schema.decodeUnknownSync(Dispatch)({
        source: {
          installationId: "provider-fixture",
          subscriptionId: "provider-fixture",
        },
        attemptId: "deadline-attempt",
        broadcasterId: "200",
        replyParentId: "reply",
        text: "Sensors",
        deadline: remaining,
      });

      const fiber = yield* provider
        .send("token", "100", input)
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* TestClock.adjust(Math.min(remaining, 4000));
      expect(yield* Fiber.join(fiber)).toEqual({ kind: "ambiguous" });
      expect(attempts).toBe(1);
      expect(aborted).toEqual([Math.min(remaining, 4000)]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "localhost OAuth exchanges use the exact redirect registered for browser authorization",
  Effect.gen(function* () {
    const f = yield* nativeFixture(
      () =>
        Response.json({
          access_token: "controlled-token",
          expires_in: 3600,
          token_type: "bearer",
        }),
      {
        ...nativeConfig,
        redirect: "http://localhost:3000/oauth/twitch/callback",
      },
    );

    yield* f.provider.exchange("controlled-code");
    const body = f.requests[0]?.request.body;

    if (!body || !Predicate.isTagged(body, "Uint8Array"))
      return yield* Effect.die("Expected form request");
    const params = new URLSearchParams(new TextDecoder().decode(body.body));
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:3000/oauth/twitch/callback",
    );
    expect(params.get("grant_type")).toBe("authorization_code");
  }),
);
