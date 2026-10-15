import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Cause, Clock, Effect, Layer, Redacted, Schema } from "effect";
import { Dispatch } from "../src/twitch-contracts.js";
import { makeProvider } from "../src/twitch-provider.js";

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
  const provider = makeProvider(
    {
      clientId: "fixture-twitch",
      clientSecret: Redacted.make("canary-client-secret"),
      signingSecret: Redacted.make("canary-signing-secret"),
      callback: "https://callback.invalid/webhooks/twitch",
      redirect: "https://callback.invalid/oauth/twitch/callback",
    },
    { api: base, oauth: base },
  );
  const now = yield* Clock.currentTimeMillis;
  const input = Schema.decodeUnknownSync(Dispatch)({
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
    if (failure._tag === "Failure")
      expect(Cause.pretty(failure.cause)).not.toContain("canary");
  }),
);
