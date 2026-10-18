import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Fiber, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { digest, request } from "../src/provider-http.js";
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
  "a returned HTTP 401 survives wire truncation without consuming its body",
  Effect.gen(function* () {
    const wire = yield* truncatedWireResponse(401);
    const fiber = yield* request(wire.url, {}).pipe(
      Effect.provideService(FetchHttpClient.Fetch, wire.fetch),
      Effect.forkChild,
    );
    const { response, signal } = yield* Effect.promise(() => wire.observed);
    expect(response.status).toBe(401);
    expect(response.bodyUsed).toBe(false);
    yield* wire.truncate;
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: 401, body: null });
    expect(response.bodyUsed).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(wire.calls).toEqual({ fetch: 1, requests: 1, bodyAccesses: 0 });
  }).pipe(Effect.timeout(2_000)),
);

test(
  "fetch rejection without a Response remains a network failure after one attempt",
  Effect.gen(function* () {
    let calls = 0;
    const rejectedFetch: typeof fetch = Object.assign(
      async () => {
        calls++;
        throw Object.assign(
          new Error("The socket connection was closed unexpectedly."),
          {
            code: "ECONNRESET",
          },
        );
      },
      { preconnect: fetch.preconnect },
    );
    expect(
      yield* request("http://127.0.0.1/users", {}).pipe(
        Effect.provideService(FetchHttpClient.Fetch, rejectedFetch),
        Effect.flip,
      ),
    ).toMatchObject({ _tag: "ProviderError", kind: "network" });
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

for (const status of [200, 204, 429])
  test(
    `empty HTTP ${status} bodies decode to null`,
    Effect.gen(function* () {
      const f = yield* fixture();
      f.control.responses.set(
        "GET /users",
        () => new Response(null, { status }),
      );
      expect(yield* request(`${f.base}/users`, {})).toMatchObject({
        status,
        body: null,
      });
      expect(f.control.requests).toEqual([{ method: "GET", path: "/users" }]);
    }),
  );

for (const status of [200, 429])
  test(
    `a returned HTTP ${status} fails on wire truncation after receiving valid JSON bytes`,
    Effect.gen(function* () {
      const wire = yield* truncatedWireResponse(status);
      const fiber = yield* request(wire.url, {}).pipe(
        Effect.provideService(FetchHttpClient.Fetch, wire.fetch),
        Effect.result,
        Effect.forkChild,
      );
      const { response, signal } = yield* Effect.promise(() => wire.observed);
      expect(response.status).toBe(status);
      yield* wire.truncate;
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProviderError", kind: "network" },
      });
      expect(signal?.aborted).toBe(true);
      expect(wire.calls.fetch).toBe(1);
      expect(wire.calls.requests).toBe(1);
      expect(wire.calls.bodyAccesses).toBeGreaterThan(0);
    }).pipe(Effect.timeout(2_000)),
  );

for (const status of [200, 429])
  test(
    `a truncated HTTP ${status} body fails even when its received bytes are valid JSON`,
    Effect.gen(function* () {
      let calls = 0;
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket) {
            calls++;
            socket.end(
              `HTTP/1.1 ${status} Response\r\nContent-Length: 10000\r\nConnection: close\r\n\r\n{}`,
            );
          },
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
      expect(
        yield* request(`http://127.0.0.1:${server.port}/users`, {}).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "ProviderError",
        kind: "network",
      });
      expect(calls).toBe(1);
    }),
  );

for (const phase of ["headers", "body"])
  for (const stop of ["timeout", "interrupt"])
    test(
      `${stop} while awaiting ${phase} aborts the HTTP connection after one attempt`,
      Effect.gen(function* () {
        let calls = 0;
        const entered = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const server = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            data(socket) {
              calls++;
              if (phase === "body")
                socket.write(
                  "HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n{",
                );
              entered.resolve();
            },
            close() {
              closed.resolve();
            },
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
        const fiber = yield* request(
          `http://127.0.0.1:${server.port}/users`,
          {},
          stop === "timeout" ? 100 : 2_000,
        ).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => entered.promise).pipe(
          Effect.timeout(1_000),
        );
        if (stop === "interrupt") yield* Fiber.interrupt(fiber);
        else
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProviderError", kind: "network" },
          });
        yield* Effect.promise(() => closed.promise).pipe(Effect.timeout(1_000));
        expect(calls).toBe(1);
      }),
    );

test(
  "accepted bodies are capped at 256 KiB of bytes including JSON framing",
  Effect.gen(function* () {
    const f = yield* fixture();
    const text = "é".repeat(131_071);
    f.control.responses.set("GET /users", () => Response.json(text));
    expect((yield* request(`${f.base}/users`, {})).body).toBe(text);
    f.control.responses.set("GET /users", () => Response.json(`${text}a`));
    expect(
      yield* request(`${f.base}/users`, {}).pipe(Effect.flip),
    ).toMatchObject({ kind: "network" });
    expect(f.control.requests).toHaveLength(2);
  }),
);

test(
  "manual redirects preserve the original method, headers and body without a second request",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.responses.set("POST /redirect", async (incoming) => {
      expect(incoming.headers.get("Authorization")).toBe("canary-token");
      expect(await incoming.text()).toBe("payload");
      return new Response(null, {
        status: 307,
        headers: { Location: `${f.base}/users` },
      });
    });
    const response = yield* request(`${f.base}/redirect`, {
      method: "POST",
      headers: { Authorization: "canary-token" },
      body: "payload",
      redirect: "follow",
    });
    expect(response).toMatchObject({ status: 307, body: null });
    expect(response.headers.get("Location")).toBe(`${f.base}/users`);
    expect(f.control.requests).toEqual([{ method: "POST", path: "/redirect" }]);
  }),
);

test(
  "plain callers receive the same lowercase SHA-256 fingerprints for empty, ASCII and Unicode text",
  Effect.gen(function* () {
    expect(yield* digest("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(yield* digest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(yield* digest("Sensors 👋 café")).toBe(
      "7b611a4150c96be3257287fed3fc069a01bb8dd2a249950b71edbd0afeec328a",
    );
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

const truncatedWireResponse = Effect.fnUntraced(function* (status: number) {
  const connected = Promise.withResolvers<Bun.Socket<string>>();
  const observed = Promise.withResolvers<{
    response: Response;
    signal: AbortSignal | null | undefined;
  }>();
  const closed = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const calls = { fetch: 0, requests: 0, bodyAccesses: 0 };
  const server = Bun.listen<string>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = "";
      },
      data(socket, bytes) {
        socket.data += bytes.toString();
        if (!socket.data.includes("\r\n\r\n")) return;
        socket.data = "";
        calls.requests++;
        socket.write(
          `HTTP/1.1 ${status} Response\r\nContent-Length: 10000\r\nConnection: close\r\n\r\n{}`,
        );
        connected.resolve(socket);
      },
      close() {
        closed.resolve();
      },
    },
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      released.resolve();
      server.stop(true);
    }),
  );
  const coordinatedFetch: typeof fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      calls.fetch++;
      const response = await fetch(...args);
      const body = response.body;
      Object.defineProperty(response, "body", {
        get() {
          calls.bodyAccesses++;
          return body;
        },
      });
      observed.resolve({ response, signal: args[1]?.signal });
      await released.promise;
      return response;
    },
    { preconnect: fetch.preconnect },
  );
  return {
    url: `http://127.0.0.1:${server.port}/users`,
    fetch: coordinatedFetch,
    observed: observed.promise,
    calls,
    truncate: Effect.promise(async () => {
      const socket = await connected.promise;
      socket.end();
      await closed.promise;
      released.resolve();
    }),
  };
});

function sendInput() {
  return Schema.decodeUnknownSync(Dispatch)({
    attemptId: Dispatch.fields.attemptId.make("http-attempt"),
    broadcasterId: Dispatch.fields.broadcasterId.make("200"),
    replyParentId: Dispatch.fields.replyParentId.make("reply"),
    text: "Sensors",
    deadline: Dispatch.fields.deadline.make(Date.now() + 10_000),
  });
}
