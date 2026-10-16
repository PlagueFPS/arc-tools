import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Schema } from "effect";
import { request } from "../src/provider-http.js";
import { Dispatch } from "../src/twitch-contracts.js";
import { fixture } from "./subscription-fixture.js";

const { test } = Test.make({ providers: Layer.empty });
const errorBodies: { name: string; response: () => Response }[] = [
  {
    name: "HTML",
    response: () => new Response("<html>canary-body</html>", { status: 401 }),
  },
  {
    name: "malformed JSON",
    response: () => new Response("{canary-body", { status: 401 }),
  },
  {
    name: "oversized",
    response: () => new Response("x".repeat(300_000), { status: 401 }),
  },
  { name: "empty", response: () => new Response(null, { status: 401 }) },
  {
    name: "hanging",
    response: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
        { status: 401 },
      ),
  },
];

for (const body of errorBodies) {
  test(
    `explicit 401 survives ${body.name} bodies across every authenticated Twitch operation`,
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* f.construct("secret-A");
      for (const path of [
        "GET /users",
        "GET /eventsub/subscriptions",
        "DELETE /eventsub/subscriptions",
        "POST /eventsub/subscriptions",
        "GET /validate",
        "POST /chat/messages",
        "POST /token",
      ])
        f.control.responses.set(path, body.response);
      const input = sendInput();
      expect([
        (yield* a.provider
          .users("canary-token", ["fixture_sender"])
          .pipe(Effect.flip)).code,
        (yield* a.provider.list("canary-token").pipe(Effect.flip)).code,
        (yield* a.provider
          .remove("canary-token", "subscription")
          .pipe(Effect.flip)).code,
        (yield* a.provider
          .create("canary-token", "200", "100")
          .pipe(Effect.flip)).code,
        (yield* a.provider.validate("canary-token").pipe(Effect.flip)).code,
      ]).toEqual(["client", "client", "client", "client", "client"]);
      expect(yield* a.provider.send("canary-token", "100", input)).toEqual({
        kind: "unauthorized",
      });
      expect((yield* a.provider.mint().pipe(Effect.flip)).code).toBe(
        "provider",
      );
      expect(
        (yield* a.provider.exchange("canary-code").pipe(Effect.flip)).code,
      ).toBe("provider");
      expect(f.control.requests).toEqual([
        { method: "GET", path: "/users" },
        { method: "GET", path: "/eventsub/subscriptions" },
        { method: "DELETE", path: "/eventsub/subscriptions" },
        { method: "POST", path: "/eventsub/subscriptions" },
        { method: "GET", path: "/validate" },
        { method: "POST", path: "/chat/messages" },
        { method: "POST", path: "/token" },
        { method: "POST", path: "/token" },
      ]);
    }).pipe(Effect.timeout(2_000)),
  );
}

test(
  "status-first rejection cancels a hanging response body",
  Effect.gen(function* () {
    const f = yield* fixture();
    const cancelled = Promise.withResolvers<void>();
    f.control.responses.set("GET /users", (incoming) => {
      incoming.signal.addEventListener("abort", () => cancelled.resolve(), {
        once: true,
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            cancelled.resolve();
          },
        }),
        { status: 401 },
      );
    });
    const response = yield* request(`${f.base}/users`, {});
    expect(response).toMatchObject({ status: 401, body: null });
    yield* Effect.promise(() => cancelled.promise).pipe(Effect.timeout(1_000));
    expect(f.control.requests.length).toBe(1);
  }),
);

test(
  "a truncated HTTP 401 keeps its rejection despite a short body on the wire",
  Effect.gen(function* () {
    let calls = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          calls++;
          socket.end(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 10000\r\nConnection: close\r\n\r\n{",
          );
        },
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
    expect(
      yield* request(`http://127.0.0.1:${server.port}/users`, {}),
    ).toMatchObject({ status: 401, body: null });
    expect(calls).toBe(1);
  }),
);

test(
  "JSON 429 bodies and rate-limit headers survive the shared HTTP boundary",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    const reset = Math.ceil((Date.now() + 2_000) / 1000);
    const limited = () =>
      Response.json(
        { retry_after: 0.01 },
        {
          status: 429,
          headers: {
            "Ratelimit-Remaining": "0",
            "Ratelimit-Reset": String(reset),
          },
        },
      );
    f.control.responses.set("GET /users", limited);
    f.control.responses.set("POST /chat/messages", limited);
    const response = yield* request(`${f.base}/users`, {});
    expect({
      status: response.status,
      body: response.body,
      remaining: response.headers.get("Ratelimit-Remaining"),
      reset: response.headers.get("Ratelimit-Reset"),
    }).toEqual({
      status: 429,
      body: { retry_after: 0.01 },
      remaining: "0",
      reset: String(reset),
    });
    expect(yield* a.provider.send("token", "100", sendInput())).toEqual({
      kind: "limited",
      retryAt: reset * 1000,
    });
    expect(f.control.requests).toEqual([
      { method: "GET", path: "/users" },
      { method: "POST", path: "/chat/messages" },
    ]);
  }),
);

for (const body of [
  "{",
  JSON.stringify({ data: [{ is_sent: "true" }] }),
  "x".repeat(300_000),
]) {
  test(
    `invalid successful send ${body.length} bytes stays ambiguous without POST replay`,
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* f.construct("secret-A");
      yield* f.grants(a.service);
      yield* a.service.setup("operator");
      f.control.responses.set(
        "POST /chat/messages",
        () => new Response(body, { status: 200 }),
      );
      const input = sendInput();
      expect(yield* a.service.dispatch(input)).toEqual({ kind: "ambiguous" });
      expect(yield* a.service.dispatch(input)).toEqual({ kind: "ambiguous" });
      expect((yield* a.service.status()).credential).toBe("valid");
      expect(
        f.control.requests.filter((entry) => entry.path === "/chat/messages"),
      ).toEqual([{ method: "POST", path: "/chat/messages" }]);
    }),
  );
}

function sendInput() {
  return Schema.decodeUnknownSync(Dispatch)({
    attemptId: Dispatch.fields.attemptId.make("http-attempt"),
    broadcasterId: Dispatch.fields.broadcasterId.make("200"),
    replyParentId: Dispatch.fields.replyParentId.make("reply"),
    text: "Sensors",
    deadline: Dispatch.fields.deadline.make(Date.now() + 10_000),
  });
}
