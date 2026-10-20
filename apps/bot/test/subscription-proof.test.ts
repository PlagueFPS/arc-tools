import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Match, Effect, Fiber, Layer, Redacted, Schema } from "effect";

import { EnvironmentConfig } from "../src/config.js";
import type { AccountConfig } from "../src/twitch-account.js";
import { subscriptionBinding } from "../src/twitch-binding.js";
import type { Subscription } from "../src/twitch-provider.js";
import {
  callback,
  fixture,
  identity,
  observation,
  responseGate,
} from "./subscription-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

test(
  "late B creation and C conflict cannot claim C ownership; manual repair replaces B",
  Effect.gen(function* () {
    const f = yield* fixture();
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    f.control.loseB = true;
    yield* b.service.setup("operator").pipe(Effect.exit);
    const c = yield* f.construct("secret-C");
    yield* f.grants(c.service);
    const conflict = yield* c.service.setup("operator");

    const afterConflict = {
      setup: conflict.status.setup,
      binding: f.snapshot().subscriptions["200"]?.binding ?? null,
      secret: f.control.secrets.get("late-B"),
      outcome: (yield* f.send(c.service, "after-conflict")).kind,
      ...f.control.calls,
    };

    yield* c.service.setup("operator");
    yield* c.service.setup("operator");
    expect(afterConflict).toEqual({
      setup: "pending",
      binding: null,
      secret: "secret-B",
      outcome: "rejected",
      get: 2,
      post: 2,
      delete: 0,
      conflict: 1,
      send: 0,
    });
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-C"]);
    expect(f.snapshot().subscriptions["200"]?.binding).toBe(
      c.config.subscriptionBinding,
    );
    expect(f.control.calls).toEqual({
      get: 4,
      post: 3,
      delete: 1,
      conflict: 1,
      send: 0,
    });
  }),
);

test(
  "completing rotated grants cannot make retained enabled A ready or dispatchable",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    const status = yield* b.service.status();
    const outcome = yield* f.send(b.service, "after-grants");
    expect({
      setup: status.setup,
      outcome: outcome.kind,
      sends: f.control.calls.send,
      remote: [...f.control.remote.keys()].map((id) =>
        f.control.secrets.get(id),
      ),
    }).toEqual({
      setup: "repair-required",
      outcome: "rejected",
      sends: 0,
      remote: ["secret-A"],
    });
  }),
);

test(
  "a conflict with invisible remote state stays pending with one create per setup turn",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.conflictOnly = true;

    for (let turn = 1; turn <= 3; turn++) {
      expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
      expect(f.control.calls).toEqual({
        get: turn,
        post: turn,
        delete: 0,
        conflict: turn,
        send: 0,
      });
      expect(f.snapshot().subscriptions).toEqual({});
    }

    f.control.conflictOnly = false;
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.control.calls.post).toBe(4);
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-A"]);
  }),
);

test(
  "lost 202 receipts are replaced; persisted exact IDs survive reconstruction without create",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.loseReceipt = true;
    expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
    expect(f.snapshot().subscriptions).toEqual({});
    expect(f.control.secrets.get("created-1")).toBe("secret-A");
    f.control.loseReceipt = false;
    const recovered = yield* f.construct("secret-A");
    expect((yield* recovered.service.setup("operator")).status.setup).toBe(
      "ready",
    );
    expect(f.control.calls).toEqual({
      get: 2,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
    expect(f.snapshot().revoked["created-1"]?.until).toBeGreaterThan(
      Date.now(),
    );
    expect(f.snapshot().subscriptions["200"]?.id).toBe("created-2");
    const persisted = yield* f.construct("secret-A");
    expect((yield* persisted.service.setup("operator")).status.setup).toBe(
      "ready",
    );
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
  "a crash before persisting C's conflict receipt still repairs late B under reconstructed C",
  Effect.gen(function* () {
    const f = yield* fixture();
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    f.control.loseB = true;
    yield* b.service.setup("operator");
    const c = yield* f.construct("secret-C");
    yield* f.grants(c.service);
    f.control.conflictOnly = true;
    yield* c.service.setup("operator");
    const recovered = yield* f.construct("secret-C");
    f.control.conflictOnly = false;
    expect((yield* recovered.service.setup("operator")).status.setup).toBe(
      "pending",
    );
    expect(f.control.secrets.get("late-B")).toBe("secret-B");
    expect((yield* recovered.service.setup("operator")).status.setup).toBe(
      "ready",
    );
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-C"]);
    expect(f.control.calls).toEqual({
      get: 4,
      post: 4,
      delete: 1,
      conflict: 2,
      send: 0,
    });
  }),
);

test(
  "successive rotations cannot turn delayed B completions into C or D proof",
  Effect.gen(function* () {
    const f = yield* fixture();
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    const gate = responseGate();
    f.control.createGate = gate;

    const creating = yield* b.service
      .setup("operator")
      .pipe(Effect.exit, Effect.forkChild);

    yield* Effect.promise(() => gate.entered.promise);
    expect(f.snapshot().subscriptions).toEqual({});
    const c = yield* f.construct("secret-C");
    yield* f.grants(c.service);
    const d = yield* f.construct("secret-D");
    yield* f.grants(d.service);
    f.control.createGate = null;
    gate.release.resolve();
    const stale = yield* Fiber.join(creating);
    expect(stale._tag).toBe("Failure");
    expect(f.snapshot().subscriptions).toEqual({});
    expect((yield* d.service.setup("operator")).status.setup).toBe("ready");
    expect(f.control.calls).toEqual({
      get: 2,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-D"]);
  }),
);

for (const change of ["sender", "callback", "binding", "ingress"]) {
  test(
    `${change} rotation keeps status and the atomic dispatch claim unavailable until repair`,
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* f.construct("secret-A");
      yield* f.grants(a.service);
      yield* a.service.setup("operator");

      if (change === "sender") f.control.senderId = "101";

      const overrides: Partial<AccountConfig> = Match.value(change).pipe(
        Match.when("callback", () => ({
          callback: "https://replacement.invalid/webhooks/twitch",
        })),
        Match.when("ingress", () => ({ webhookReady: false })),
        Match.orElse(() => ({})),
      );

      const b = yield* f.construct(
        change === "binding" ? "secret-B" : "secret-A",
        { ...overrides, revision: `rotated-${change}` },
      );

      yield* f.grants(b.service);
      expect((yield* b.service.status()).setup).toBe(
        change === "ingress" ? "ingress-required" : "repair-required",
      );
      expect(yield* f.send(b.service, `rotated-${change}`)).toEqual({
        kind: "rejected",
      });
      expect(f.control.calls.send).toBe(0);
      expect(f.control.secrets.get("created-1")).toBe("secret-A");

      if (change !== "ingress") {
        expect((yield* b.service.setup("operator")).status.setup).toBe("ready");
        expect(f.control.calls.delete).toBe(1);
        expect(f.control.calls.post).toBe(2);
      }
    }),
  );
}

test(
  "unknown signed positives cannot create proof and old ingress cannot relabel observations",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.observeSubscription(
      observation(a.config, "unknown", "enabled"),
    );
    yield* a.service.observeSubscription(
      observation(
        a.config,
        "challenge",
        "webhook_callback_verification_pending",
      ),
    );
    expect(f.snapshot().subscriptions).toEqual({});
    f.control.phase = "webhook_callback_verification_pending";
    expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
    yield* a.service.observeSubscription(
      observation(
        a.config,
        "created-1",
        "webhook_callback_verification_pending",
      ),
    );
    expect((yield* a.service.status()).setup).toBe("pending");

    const oldBinding = {
      ...observation(a.config, "created-1", "enabled"),
      binding: "old-ingress-binding",
    };

    yield* a.service.observeSubscription(oldBinding);
    yield* a.service.observeSubscription({
      ...observation(a.config, "created-1", "enabled"),
      callback: "https://old.invalid/webhooks/twitch",
    });
    expect((yield* a.service.status()).setup).toBe("pending");
    expect(yield* f.send(a.service, "pending-proof")).toEqual({
      kind: "rejected",
    });
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "enabled"),
    );
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.snapshot().subscriptions["200"]?.id).toBe("created-1");
    expect(f.control.calls).toEqual({
      get: 2,
      post: 1,
      delete: 0,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "current-binding revocation before 202 persistence fences the receipt and cannot be resurrected",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    const gate = responseGate();
    f.control.createGate = gate;

    const creating = yield* a.service
      .setup("operator")
      .pipe(Effect.exit, Effect.forkChild);

    yield* Effect.promise(() => gate.entered.promise);
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    const retiredUntil = f.snapshot().revoked["created-1"]?.until;
    expect(retiredUntil).toBeGreaterThan(Date.now());
    f.control.createGate = null;
    gate.release.resolve();
    expect((yield* Fiber.join(creating))._tag).toBe("Failure");
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "enabled"),
    );
    expect(f.snapshot().subscriptions).toEqual({});
    expect((yield* a.service.status()).sender?.authorized).toBeFalse();
    expect(yield* f.send(a.service, "revoked-before-receipt")).toEqual({
      kind: "rejected",
    });
    yield* f.grants(a.service);
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "enabled"),
    );
    expect(f.snapshot().subscriptions["200"]?.id).toBe("created-2");
    expect(f.snapshot().revoked["created-1"]?.until).toBe(retiredUntil);
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
  "retirement is durable before DELETE and a retired positive cannot authorize dispatch",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    const gate = responseGate();
    f.control.deleteGate = gate;
    const repairing = yield* b.service.setup("operator").pipe(Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    expect(f.snapshot().subscriptions).toEqual({});
    expect(f.snapshot().revoked["created-1"]?.until).toBeGreaterThan(
      Date.now(),
    );
    yield* b.service.observeSubscription(
      observation(b.config, "created-1", "enabled"),
    );
    expect(yield* f.send(b.service, "retiring-id")).toEqual({
      kind: "rejected",
    });
    f.control.deleteGate = null;
    gate.release.resolve();
    expect((yield* Fiber.join(repairing)).status.setup).toBe("ready");
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
  "expired claims cannot persist receipts or retire subscriptions after a network await",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    const gate = responseGate();
    f.control.createGate = gate;

    const creating = yield* a.service
      .setup("operator")
      .pipe(Effect.exit, Effect.forkChild);

    yield* Effect.promise(() => gate.entered.promise);
    yield* f.store.update((state) => {
      if (state.setupLease)
        state.setupLease = { ...state.setupLease, until: 0 };
    });
    f.control.createGate = null;
    gate.release.resolve();
    expect((yield* Fiber.join(creating))._tag).toBe("Failure");
    expect(f.snapshot().subscriptions).toEqual({});
    const listGate = responseGate();
    f.control.listGate = listGate;

    const listing = yield* a.service
      .setup("operator")
      .pipe(Effect.exit, Effect.forkChild);

    yield* Effect.promise(() => listGate.entered.promise);
    yield* f.store.update((state) => {
      if (state.setupLease)
        state.setupLease = { ...state.setupLease, until: 0 };
    });
    f.control.listGate = null;
    listGate.release.resolve();
    expect((yield* Fiber.join(listing))._tag).toBe("Failure");
    expect(f.snapshot().revoked).toEqual({});
    expect(f.control.calls).toEqual({
      get: 2,
      post: 1,
      delete: 0,
      conflict: 0,
      send: 0,
    });
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
  "cleanup leaves unrelated EventSub types, versions and transports untouched",
  Effect.gen(function* () {
    const f = yield* fixture();

    const base: Subscription = {
      id: "other-type",
      type: "channel.follow",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "200", user_id: "100" },
      transport: { method: "webhook", callback },
    };

    const unrelated = [
      base,
      {
        ...base,
        id: "other-version",
        type: "channel.chat.message",
        version: "2",
      },
      {
        ...base,
        id: "other-transport",
        type: "channel.chat.message",
        transport: { method: "websocket" },
      },
    ];

    for (const sub of unrelated) f.control.remote.set(sub.id, sub);
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    const known = yield* a.service.setup("operator");
    expect(known.status.setup).toBe("ready");
    expect(f.control.calls.delete).toBe(0);
    expect([...f.control.remote.keys()]).toEqual([
      "other-type",
      "other-version",
      "other-transport",
      "created-1",
    ]);
    expect(f.control.calls).toEqual({
      get: 1,
      post: 1,
      delete: 0,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "only a fully matched single 202 receipt proves the exact request binding",
  Effect.gen(function* () {
    const f = yield* fixture();

    const a = yield* f.construct("secret-A", {
      subscriptionBinding: "account-stamp-must-not-be-used",
    });

    const receipt = {
      id: "created-1",
      status: "webhook_callback_verification_pending",
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "200", user_id: "100" },
      transport: { method: "webhook", callback },
    };

    f.control.phase = receipt.status;
    f.control.response = { status: 202, body: { data: [receipt] } };
    const created = yield* a.provider.create("app-token", "200", "100");
    expect(created).toEqual({
      kind: "created",
      subscription: {
        id: "created-1",
        broadcasterId: "200",
        senderId: "100",
        callback,
        binding: yield* subscriptionBinding({
          callback,
          clientId: identity.twitchClientId,
          signingSecret: Redacted.make("secret-A"),
        }),
        status: "webhook_callback_verification_pending",
      },
    });
    expect(f.control.secrets.get("created-1")).toBe("secret-A");

    const malformed = [
      {},
      { data: [] },
      { data: [receipt, receipt] },
      { data: [{ ...receipt, id: undefined }] },
      { data: [{ ...receipt, id: "" }] },
      { data: [{ ...receipt, type: "channel.follow" }] },
      { data: [{ ...receipt, version: "2" }] },
      {
        data: [
          {
            ...receipt,
            condition: { ...receipt.condition, broadcaster_user_id: "201" },
          },
        ],
      },
      {
        data: [
          { ...receipt, condition: { ...receipt.condition, user_id: "101" } },
        ],
      },
      {
        data: [
          {
            ...receipt,
            transport: { ...receipt.transport, method: "websocket" },
          },
        ],
      },
      {
        data: [
          {
            ...receipt,
            transport: {
              ...receipt.transport,
              callback: "https://other.invalid/webhook",
            },
          },
        ],
      },
      { data: [{ ...receipt, transport: { method: "webhook" } }] },
      { data: [{ ...receipt, status: "authorization_revoked" }] },
      { data: [{ ...receipt, id: "x".repeat(129) }] },
      { data: [receipt], padding: "x".repeat(256 * 1024) },
    ];

    for (const body of malformed) {
      f.control.remote.clear();
      f.control.response = { status: 202, body };
      expect(yield* a.provider.create("app-token", "200", "100")).toEqual({
        kind: "unknown",
      });
    }

    f.control.remote.clear();
    f.control.malformed = true;
    expect(yield* a.provider.create("app-token", "200", "100")).toEqual({
      kind: "unknown",
    });
    expect(f.control.calls.post).toBe(17);
    expect(JSON.stringify(created)).not.toContain("secret-A");
    expect(f.control.calls.send).toBe(0);
  }),
);

test(
  "create distinguishes 409, explicit 401 and uncertain POST outcomes without replay",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    f.control.conflictOnly = true;
    expect(yield* a.provider.create("app-token", "200", "100")).toEqual({
      kind: "conflict",
    });
    f.control.conflictOnly = false;
    f.control.response = { status: 401, body: { message: "private-canary" } };
    expect(
      (yield* a.provider.create("app-token", "200", "100").pipe(Effect.flip))
        .code,
    ).toBe("client");

    for (const status of [200, 201, 403, 429, 500]) {
      f.control.response = { status, body: {} };
      expect(yield* a.provider.create("app-token", "200", "100")).toEqual({
        kind: "unknown",
      });
    }

    f.control.response = null;
    f.control.disconnect = true;
    expect(yield* a.provider.create("app-token", "200", "100")).toEqual({
      kind: "unknown",
    });
    expect(f.control.calls).toEqual({
      get: 0,
      post: 8,
      delete: 0,
      conflict: 1,
      send: 0,
    });
    expect(f.control.secrets.get("created-8")).toBe("secret-A");
  }),
);

test(
  "a create 401 invalidates the session while an uncertain create only leaves subscription pending",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.response = { status: 401, body: {} };
    expect((yield* a.service.setup("operator").pipe(Effect.flip)).code).toBe(
      "client",
    );
    expect((yield* a.service.status()).credential).toBe("absent");
    f.control.response = { status: 500, body: {} };
    expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
    expect((yield* a.service.status()).credential).toBe("valid");
    expect(f.control.calls).toEqual({
      get: 2,
      post: 2,
      delete: 0,
      conflict: 0,
      send: 0,
    });
  }),
);

test(
  "C lost response after replacing late B requires a fresh C receipt on reconstruction",
  Effect.gen(function* () {
    const f = yield* fixture();
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    f.control.loseB = true;
    yield* b.service.setup("operator");
    const c = yield* f.construct("secret-C");
    yield* f.grants(c.service);
    expect((yield* c.service.setup("operator")).status.setup).toBe("pending");
    const gate = responseGate();
    f.control.createGate = gate;
    const creating = yield* c.service.setup("operator").pipe(Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    expect(f.control.secrets.get("created-3")).toBe("secret-C");
    expect(f.snapshot().subscriptions).toEqual({});
    yield* Fiber.interrupt(creating);
    f.control.createGate = null;
    gate.release.resolve();
    const recovered = yield* f.construct("secret-C");
    expect((yield* recovered.service.setup("operator")).status.setup).toBe(
      "ready",
    );
    expect(f.snapshot().subscriptions["200"]?.id).toBe("created-4");
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-C"]);
    expect(f.control.calls).toEqual({
      get: 4,
      post: 4,
      delete: 2,
      conflict: 1,
      send: 0,
    });
  }),
);

test(
  "multiple missing channels perform one create each per turn even when every POST conflicts",
  Effect.gen(function* () {
    const f = yield* fixture();

    const a = yield* f.construct("secret-A", {
      identity: Schema.decodeUnknownSync(EnvironmentConfig)({
        ...identity,
        channelLogins: ["fixture_channel", "fixture_other"],
      }),
    });

    yield* f.grants(a.service);
    f.control.conflictOnly = true;

    for (let turn = 1; turn <= 2; turn++) {
      expect((yield* a.service.setup("operator")).status.setup).toBe("pending");
      expect(f.control.calls).toEqual({
        get: turn,
        post: 2 * turn,
        delete: 0,
        conflict: 2 * turn,
        send: 0,
      });
      expect(f.snapshot().subscriptions).toEqual({});
    }

    f.control.conflictOnly = false;
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.control.calls).toEqual({
      get: 3,
      post: 6,
      delete: 0,
      conflict: 4,
      send: 0,
    });
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-A", "secret-A"]);
  }),
);

test(
  "revoked confirmed metadata cannot revive after its tombstone expires",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "authorization_revoked"),
    );
    expect(f.snapshot().revoked["created-1"]?.until).toBeGreaterThan(
      Date.now() + 599_000,
    );
    yield* f.store.update((state) => {
      state.revoked["created-1"] = {
        until: 0,
        reason: "authorization-revoked",
      };
    });
    yield* a.service.status();
    expect(f.snapshot().revoked).toEqual({});
    yield* a.service.observeSubscription(
      observation(a.config, "created-1", "enabled"),
    );
    expect(f.snapshot().subscriptions["200"]?.status).toBe(
      "authorization_revoked",
    );
    expect((yield* a.service.status()).setup).toBe("repair-required");
    yield* f.grants(a.service);
    expect((yield* a.service.setup("operator")).status.setup).toBe("ready");
    expect(f.snapshot().subscriptions["200"]?.id).toBe("created-2");
    expect(f.control.calls).toEqual({
      get: 2,
      post: 2,
      delete: 1,
      conflict: 0,
      send: 0,
    });
  }),
);
