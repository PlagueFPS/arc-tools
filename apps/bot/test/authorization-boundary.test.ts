import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Fiber, Layer } from "effect";

import { fixture, observation, responseGate } from "./subscription-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

test(
  "confirmed list authorization loss remains repairable after retirement and signed revocation",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const record = f.control.remote.get("created-1");
    if (!record) throw new Error("missing confirmed fixture subscription");
    f.control.remote.set(record.id, {
      ...record,
      status: "authorization_revoked",
    });
    f.control.response = { status: 403, body: "missing grant" };
    const first = yield* a.service.setup("operator").pipe(Effect.result);
    yield* a.service.observeSubscription(
      observation(a.config, record.id, "authorization_revoked"),
    );
    const second = yield* a.service.setup("operator");
    expect({
      first:
        first._tag === "Failure"
          ? first.failure.code
          : first.success.status.setup,
      links: second.authorizations.map((entry) => entry.login).sort(),
      sender: second.status.sender?.authorized,
      channel: second.status.channels[0]?.authorized,
      calls: f.control.calls,
    }).toEqual({
      first: "stale",
      links: ["fixture_channel", "fixture_sender"],
      sender: false,
      channel: false,
      calls: { get: 2, post: 1, delete: 0, conflict: 0, send: 0 },
    });
    yield* f.authorize(a.service, second.authorizations);
    const generation = f.snapshot().authGeneration;
    yield* a.service.observeSubscription(
      observation(a.config, record.id, "authorization_revoked"),
    );
    f.control.response = null;
    const repaired = yield* a.service.setup("operator");
    expect({
      setup: repaired.status.setup,
      links: repaired.authorizations.length,
      sender: repaired.status.sender?.authorized,
      channel: repaired.status.channels[0]?.authorized,
      generation: f.snapshot().authGeneration,
      calls: f.control.calls,
    }).toEqual({
      setup: "ready",
      links: 0,
      sender: true,
      channel: true,
      generation,
      calls: { get: 3, post: 2, delete: 1, conflict: 0, send: 0 },
    });
  }),
);

test(
  "HTML users 401 invalidates the rejected credential on every setup",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.responses.set(
      "GET /users",
      () => new Response("<html>rejected</html>", { status: 401 }),
    );
    const generations: (string | undefined)[] = [];
    const codes: string[] = [];
    const credentials: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      generations.push(f.snapshot().session?.generation);
      const result = yield* a.service.setup("operator").pipe(Effect.result);
      codes.push(result._tag === "Failure" ? result.failure.code : "success");
      credentials.push((yield* a.service.status()).credential);
    }
    expect({
      codes,
      credentials,
      sameGeneration: generations[0] === generations[1],
      tokenPosts: f.control.requests.filter(
        (entry) => entry.path === "/token" && entry.method === "POST",
      ).length,
      sends: f.control.calls.send,
    }).toEqual({
      codes: ["client", "client"],
      credentials: ["absent", "absent"],
      sameGeneration: false,
      tokenPosts: 4,
      sends: 0,
    });
  }),
);

test(
  "cleanup retirement still accepts its first signed authorization loss and ignores duplicates after fresh OAuth",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    f.control.remote.clear();
    f.control.response = { status: 403, body: "forbidden" };
    expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
    expect((yield* a.service.status()).sender?.authorized).toBeTrue();
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    const repair = yield* a.service.setup("operator");
    expect(repair.authorizations.map((entry) => entry.login).sort()).toEqual([
      "fixture_channel",
      "fixture_sender",
    ]);
    expect(repair.status.channels[0]?.authorized).toBeFalse();
    yield* f.authorize(a.service, repair.authorizations);
    const generation = f.snapshot().authGeneration;
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "enabled"),
    );
    expect(f.snapshot().subscriptions).toEqual({});
    f.control.response = null;
    const ready = yield* a.service.setup("operator");
    expect({
      setup: ready.status.setup,
      links: ready.authorizations.length,
      authorized: ready.status.sender?.authorized,
      generation: f.snapshot().authGeneration,
      calls: f.control.calls,
    }).toEqual({
      setup: "ready",
      links: 0,
      authorized: true,
      generation,
      calls: { get: 3, post: 3, delete: 1, conflict: 0, send: 0 },
    });
  }),
);

test(
  "a signed grant loss during list abandons the old setup claim and returns usable repair links next turn",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const gate = responseGate();
    f.control.listGate = gate;
    const settingUp = yield* a.service
      .setup("operator")
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    f.control.listGate = null;
    gate.release.resolve();
    const abandoned = yield* Fiber.join(settingUp);
    expect(
      abandoned._tag === "Failure" ? abandoned.failure.code : "success",
    ).toBe("stale");
    const repair = yield* a.service.setup("operator");
    expect(repair.authorizations.length).toBe(2);
    expect(repair.status.sender?.authorized).toBeFalse();
    expect(yield* f.send(a.service, "stale-reconcile")).toEqual({
      kind: "rejected",
    });
    yield* f.authorize(a.service, repair.authorizations);
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.control.calls).toEqual({
      get: 3,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "unknown list IDs and old binding observations cannot invalidate current grants",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const old = f.control.remote.get("created-1");
    if (!old) throw new Error("missing fixture subscription");
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    expect((yield* b.service.setup("operator")).status.setup).toBe("ready");
    const generation = f.snapshot().authGeneration;
    f.control.remote.set(old.id, { ...old, status: "authorization_revoked" });
    yield* b.service.observeSubscription(
      observation(a.config, old.id, "authorization_revoked"),
    );
    yield* b.service.observeSubscription({
      ...observation(b.config, "created-2", "authorization_revoked"),
      callback: `${a.config.callback}/old`,
    });
    yield* b.service.observeSubscription({
      ...observation(b.config, "created-2", "authorization_revoked"),
      senderId: "old-sender",
    });
    const ready = yield* b.service.setup("operator");
    expect({
      setup: ready.status.setup,
      links: ready.authorizations.length,
      sender: ready.status.sender?.authorized,
      channel: ready.status.channels[0]?.authorized,
      generation: f.snapshot().authGeneration,
      calls: f.control.calls,
    }).toEqual({
      setup: "ready",
      links: 0,
      sender: true,
      channel: true,
      generation,
      calls: { get: 3, post: 2, delete: 2, conflict: 0, send: 0 },
    });
  }),
);

test(
  "a non-authorization revocation can later report authorization loss exactly once",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "notification_failures_exceeded"),
    );
    expect((yield* a.service.status()).sender?.authorized).toBeTrue();
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    const repair = yield* a.service.setup("operator");
    expect(repair.authorizations.length).toBe(2);
    yield* f.authorize(a.service, repair.authorizations);
    const generation = f.snapshot().authGeneration;
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "notification_failures_exceeded"),
    );
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.snapshot().authGeneration).toBe(generation);
    expect(f.control.calls).toEqual({
      get: 2,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "an unconfirmed revoked list record and replacement 403 do not claim grant-loss proof",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.loseReceipt = true;
    expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
    const remote = f.control.remote.get("created-1");
    if (!remote) throw new Error("missing unconfirmed fixture subscription");
    f.control.remote.set(remote.id, {
      ...remote,
      status: "authorization_revoked",
    });
    f.control.response = { status: 403, body: "forbidden" };
    const generation = f.snapshot().authGeneration;
    const pending = yield* a.service.setup("operator");
    expect({
      setup: pending.status.setup,
      links: pending.authorizations.length,
      sender: pending.status.sender?.authorized,
      channel: pending.status.channels[0]?.authorized,
      generation: f.snapshot().authGeneration,
      calls: f.control.calls,
    }).toEqual({
      setup: "pending",
      links: 0,
      sender: true,
      channel: true,
      generation,
      calls: { get: 2, post: 2, delete: 1, conflict: 0, send: 0 },
    });
  }),
);

test(
  "a list-confirmed revocation fences an OAuth validation already in flight",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    const initial = yield* a.service.setup("operator");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const authorization = initial.authorizations.find(
      (entry) => entry.login === "fixture_sender",
    );
    if (!authorization) throw new Error("missing fixture sender authorization");
    const params = new URL(authorization.url).searchParams;
    const gate = responseGate();
    f.control.responses.set("GET /validate", async () => {
      gate.entered.resolve();
      await gate.release.promise;
      return Response.json({
        client_id: a.config.identity.twitchClientId,
        expires_in: 3600,
        scopes: params.get("scope")?.split(" "),
        user_id: "100",
        login: "fixture_sender",
      });
    });
    const completing = yield* a.service
      .completeOAuth({
        operator: "operator",
        state: params.get("state") ?? "",
        code: "late-grant",
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    const remote = f.control.remote.get("created-1");
    if (!remote) throw new Error("missing confirmed fixture subscription");
    f.control.remote.set(remote.id, {
      ...remote,
      status: "authorization_revoked",
    });
    expect((yield* a.service.setup("operator").pipe(Effect.flip)).code).toBe(
      "stale",
    );
    f.control.responses.delete("GET /validate");
    gate.release.resolve();
    const result = yield* Fiber.join(completing);
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe(
      "state",
    );
    const repair = yield* a.service.setup("operator");
    expect(repair.status.sender?.authorized).toBeFalse();
    expect(repair.authorizations.length).toBe(2);
    yield* f.authorize(a.service, repair.authorizations);
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.control.calls).toEqual({
      get: 3,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "HTML setup 401 fences a concurrent successful credential validation across reconstruction",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const generation = f.snapshot().session?.generation;
    const reconstructed = yield* f.construct("secret-A");
    const gate = responseGate();
    f.control.responses.set("GET /validate", async () => {
      gate.entered.resolve();
      await gate.release.promise;
      return Response.json({
        client_id: a.config.identity.twitchClientId,
        expires_in: 3600,
        scopes: [],
      });
    });
    const validating = yield* reconstructed
      .credentialAlarm()
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    f.control.responses.set(
      "GET /users",
      () => new Response("<html>rejected</html>", { status: 401 }),
    );
    expect((yield* a.service.setup("operator").pipe(Effect.flip)).code).toBe(
      "client",
    );
    f.control.responses.delete("GET /validate");
    f.control.responses.delete("GET /users");
    gate.release.resolve();
    yield* Fiber.join(validating);
    expect((yield* a.service.status()).credential).toBe("absent");
    expect(f.snapshot().session).toBeNull();
    const ready = yield* a.service.setup("operator");
    expect({
      setup: ready.status.setup,
      credential: ready.status.credential,
      links: ready.authorizations.length,
      sameGeneration: f.snapshot().session?.generation === generation,
      posts: f.control.requests.filter(
        (entry) => entry.method === "POST" && entry.path === "/token",
      ).length,
      sends: f.control.calls.send,
    }).toEqual({
      setup: "ready",
      credential: "valid",
      links: 0,
      sameGeneration: false,
      posts: 4,
      sends: 0,
    });
  }),
);

test(
  "malformed successful user schema remains a provider failure without invalidating a valid credential",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    const generation = f.snapshot().session?.generation;
    f.control.responses.set("GET /users", () =>
      Response.json({ data: [{ id: 123 }] }),
    );
    expect((yield* a.service.setup("operator").pipe(Effect.flip)).code).toBe(
      "provider",
    );
    expect((yield* a.service.status()).credential).toBe("valid");
    expect(f.snapshot().session?.generation).toBe(generation);
    expect(
      f.control.requests.filter((entry) => entry.method === "POST").length,
    ).toBe(3);
    expect(f.control.calls.send).toBe(0);
  }),
);

test(
  "a delayed HTML 401 cannot invalidate the replacement credential generation",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const original = f.snapshot().session?.generation;
    const gate = responseGate();
    f.control.responses.set("GET /users", async () => {
      gate.entered.resolve();
      await gate.release.promise;
      return new Response("<html>old token rejected</html>", { status: 401 });
    });
    const settingUp = yield* a.service
      .setup("operator")
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    f.control.responses.set(
      "POST /chat/messages",
      () => new Response("{", { status: 401 }),
    );
    expect((yield* f.send(a.service, "reject-old-credential")).kind).toBe(
      "retryable",
    );
    f.control.responses.delete("POST /chat/messages");
    expect(
      (yield* f.send(a.service, "acquire-replacement-credential")).kind,
    ).toBe("retryable");
    const replacement = f.snapshot().session?.generation;
    expect(replacement).toBeString();
    expect(replacement).not.toBe(original);
    f.control.responses.delete("GET /users");
    gate.release.resolve();
    const result = yield* Fiber.join(settingUp);
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe(
      "client",
    );
    expect(f.snapshot().session?.generation).toBe(replacement);
    const ready = yield* a.service.setup("operator");
    expect({
      setup: ready.status.setup,
      credential: ready.status.credential,
      links: ready.authorizations.length,
      posts: f.control.requests.filter(
        (entry) => entry.method === "POST" && entry.path === "/token",
      ).length,
      sends: f.control.requests.filter(
        (entry) => entry.path === "/chat/messages",
      ).length,
    }).toEqual({
      setup: "ready",
      credential: "valid",
      links: 0,
      posts: 4,
      sends: 1,
    });
  }),
);
