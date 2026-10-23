import { expect } from "bun:test";

import { makeAccountStorage } from "@arctools/twitch/cloudflare";
import { DispatchOutcome } from "@arctools/twitch/server";
import {
  AccountState,
  ChannelRecord,
  SharedAccount,
  emptyState,
  joinDirectory,
  splitAccount,
} from "@arctools/twitch/testing";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";

import { harness, initial, keyedStorage } from "./account-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const runtime = RuntimeContext.of({
  Type: "test",
  id: "keyed-storage",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

const open = (storage: Parameters<typeof makeAccountStorage>[0]) =>
  makeAccountStorage(storage).pipe(
    Effect.provideService(RuntimeContext, runtime),
  );

const populated = (): AccountState =>
  Schema.decodeUnknownSync(AccountState)({
    ...emptyState("revision-one"),
    authGeneration: 17,
    publicRevocationGeneration: 9,
    sender: { login: "sender", id: "100" },
    channels: [
      { id: "300", login: "configured_first" },
      { id: "200", login: "configured_second" },
    ],
    publicMembers: [
      { id: "200", login: "public_first", revocationGeneration: 4 },
      { id: "400", login: "public_second", revocationGeneration: 9 },
    ],
    grants: {
      "100": ["user:bot", "user:read:chat", "user:write:chat"],
      "200": ["channel:bot"],
      "400": ["channel:bot"],
    },
    oauth: [
      {
        digest: "digest",
        operator: "operator",
        revision: "revision-one",
        generation: 17,
        userId: "100",
        login: "sender",
        roles: ["sender", "broadcaster"],
        scopes: ["user:bot"],
        expiresAt: initial + 1234,
      },
    ],
    enrollments: [
      {
        session: "a".repeat(64),
        nonce: "nonce-digest",
        revision: "revision-one",
        generation: 17,
        publicRevocationGeneration: 9,
        expiresAt: initial + 4321,
        phase: {
          kind: "exchanging",
          lease: { owner: "exchange-owner", until: initial + 333 },
        },
      },
    ],
    repair: {
      kind: "scheduled",
      id: "repair-id",
      due: initial + 200,
      attempts: 3,
    },
    session: {
      token: "canary",
      expiresAt: initial + 99999,
      validatedAt: initial - 123,
      generation: "session-generation",
    },
    tokenLease: { owner: "token-owner", until: initial + 12 },
    tokenRetryAt: initial + 13,
    nextCredentialCheck: initial + 100,
    setupLease: {
      owner: "setup-owner",
      until: initial + 4567,
      revision: "revision-one",
      generation: 17,
    },
    subscriptions: {
      "200": {
        id: "sub-200",
        broadcasterId: "200",
        senderId: "100",
        callback: "https://fixture.invalid/webhooks/twitch",
        binding: "binding",
        status: "enabled",
      },
      "receipt/key%": {
        id: "orphan-proof",
        broadcasterId: "500",
        senderId: "old-sender",
        callback: "https://old.invalid/webhooks/twitch",
        binding: "old-binding",
        status: "authorization_revoked",
      },
      ["__proto__"]: {
        id: "prototype-proof",
        broadcasterId: "600",
        senderId: "old-sender",
        callback: "https://old.invalid/webhooks/twitch",
        binding: "old-binding",
        status: "enabled",
      },
    },
    revoked: {
      "old/receipt%": { until: initial + 3456, reason: "retired" },
      "sub-200": { until: initial + 6543, reason: "authorization-revoked" },
      revoked: { until: initial + 2345, reason: "revoked" },
    },
    attempts: {
      waiting: {
        kind: "waiting",
        fingerprint: "waiting-fingerprint",
        deadline: initial + 111,
        retainUntil: initial + 222,
        retryAt: initial + 99,
      },
      sending: {
        kind: "sending",
        fingerprint: "sending-fingerprint",
        deadline: initial + 333,
        retainUntil: initial + 444,
        owner: "send-owner",
        instance: "send-instance",
      },
      terminal: {
        kind: "terminal",
        fingerprint: "terminal-fingerprint",
        deadline: initial + 555,
        retainUntil: initial + 666,
        outcome: { kind: "ambiguous" },
        privateCode: "private-code",
      },
    },
    reservations: [
      { channel: "200", at: initial - 123 },
      { channel: "300", at: initial - 100 },
    ],
    apiBlockedUntil: initial + 321,
    credentialFailures: 2,
  });

test(
  "first use atomically initializes current keyed tables without a legacy marker",
  Effect.gen(function* () {
    const memory = yield* keyedStorage();
    const store = yield* open(memory.storage);
    expect(memory.values.size).toBe(0);
    expect(yield* store.update((state) => structuredClone(state))).toEqual(
      emptyState(""),
    );
    expect([...memory.values.keys()].sort()).toEqual([
      "account:attempts:v1",
      "account:enrollments:v1",
      "account:oauth:v1",
      "account:shared:v1",
    ]);
    expect(memory.values.get("account:oauth:v1")).toEqual([]);
    expect(memory.values.get("account:attempts:v1")).toEqual({});
    expect(memory.values.get("account:enrollments:v1")).toEqual([]);
    expect(
      Schema.is(SharedAccount)(memory.values.get("account:shared:v1")),
    ).toBe(true);
    expect(memory.alarm()).toBeNull();
    expect(memory.traces.some((entry) => entry.key === "account:v1")).toBe(
      false,
    );
  }),
);

test(
  "populated and malformed old snapshots are ignored and untouched before and after keyed initialization",
  Effect.gen(function* () {
    for (const old of [
      Schema.encodeSync(AccountState)(populated()),
      { malformed: true },
      "not JSON",
    ]) {
      const memory = yield* keyedStorage();
      memory.values.set("account:v1", structuredClone(old));
      const store = yield* open(memory.storage);
      expect(yield* store.update((state) => structuredClone(state))).toEqual(
        emptyState(""),
      );
      expect(memory.values.get("account:v1")).toEqual(old);
      const before = structuredClone(memory.values);
      const reopened = yield* open(memory.storage);
      expect(yield* reopened.update((state) => structuredClone(state))).toEqual(
        emptyState(""),
      );
      expect(memory.values).toEqual(before);
      expect(memory.traces.some((entry) => entry.key === "account:v1")).toBe(
        false,
      );
      expect(
        [...memory.values.values()].some((value) =>
          Schema.is(Schema.Struct({ layout: Schema.String }))(value),
        ),
      ).toBe(false);
    }
  }),
);

test(
  "keyed reconstruction preserves every field, membership source, order and subscription map key without rewriting records",
  Effect.gen(function* () {
    const original = populated();
    expect(yield* joinDirectory(splitAccount(original))).toEqual(original);
    const memory = yield* keyedStorage();
    memory.restore(original);
    const before = structuredClone(memory.values);
    const store = yield* open(memory.storage);
    expect(yield* store.update((state) => structuredClone(state))).toEqual(
      original,
    );
    expect(memory.alarm()).toBe(original.nextCredentialCheck);

    const orphan = Schema.decodeUnknownSync(ChannelRecord)(
      memory.values.get("account:channel:v1/receipt%2Fkey%25"),
    );

    expect(orphan.configured).toEqual([]);
    expect(orphan.public).toEqual([]);
    expect(orphan.subscription).toEqual(
      original.subscriptions["receipt/key%"] ?? null,
    );
    const reconstructed = yield* open(memory.storage);
    expect(
      yield* reconstructed.update((state) => structuredClone(state)),
    ).toEqual(original);
    expect(memory.values).toEqual(before);
    expect(memory.control.mutations).toBe(0);
    expect(memory.traces.some((entry) => entry.key === "account:v1")).toBe(
      false,
    );
  }),
);

test(
  "directory validation returns typed failures for conflicting membership positions and keys",
  Effect.gen(function* () {
    for (const collection of ["configured", "public"] satisfies Array<
      "configured" | "public"
    >) {
      const positions = splitAccount(populated());
      positions.channels = new Map(
        [...positions.channels].map(([key, record]) => [
          key,
          {
            ...record,
            [collection]: record[collection].map((entry) => ({
              ...entry,
              position: entry.position + 1,
            })),
          },
        ]),
      );
      const positionError = yield* joinDirectory(positions).pipe(Effect.flip);
      expect(positionError._tag).toBe("DirectoryValidationError");
      expect(positionError.reason).toBe("positions");

      const keys = splitAccount(populated());
      keys.channels = new Map(
        [...keys.channels].map(([key, record]) => [
          key,
          {
            ...record,
            [collection]: record[collection].map((entry) => ({
              ...entry,
              member: { ...entry.member, id: "conflicting-id" },
            })),
          },
        ]),
      );
      const keyError = yield* joinDirectory(keys).pipe(Effect.flip);
      expect(keyError._tag).toBe("DirectoryValidationError");
      expect(keyError.reason).toBe("key");
    }
  }),
);

test(
  "every bootstrap write and alarm rolls back and can retry after reopening",
  Effect.gen(function* () {
    const initialize = (store: Effect.Success<ReturnType<typeof open>>) =>
      store.shared((state) => {
        state.nextCredentialCheck = initial + 100;
      });

    const baseline = yield* keyedStorage();
    yield* initialize(yield* open(baseline.storage));
    const mutations = baseline.control.mutations;
    expect(mutations).toBe(6);

    for (let failAt = 1; failAt <= mutations; failAt++) {
      const memory = yield* keyedStorage();
      const old = { malformed: true };
      memory.values.set("account:v1", old);
      memory.control.failAt = failAt;
      expect(
        Exit.isFailure(
          yield* Effect.exit(initialize(yield* open(memory.storage))),
        ),
      ).toBe(true);
      expect([...memory.values]).toEqual([["account:v1", old]]);
      expect(memory.alarm()).toBeNull();
      memory.control.failAt = 0;
      const reopened = yield* open(memory.storage);
      yield* initialize(reopened);
      expect(yield* reopened.update((state) => structuredClone(state))).toEqual(
        { ...emptyState(""), nextCredentialCheck: initial + 100 },
      );
      expect(memory.values).toEqual(
        new Map([["account:v1", old], ...baseline.values]),
      );
      expect(memory.alarm()).toBe(baseline.alarm());
    }
  }),
);

test(
  "missing shared headers reject every partial keyed layout without replacing records",
  Effect.gen(function* () {
    for (const key of [
      "account:channel:v1/200",
      "account:tombstone:v1/receipt",
      "account:oauth:v1",
      "account:attempts:v1",
      "account:enrollments:v1",
    ]) {
      const memory = yield* keyedStorage();
      memory.values.set(key, { retained: "fact" });
      const before = structuredClone(memory.values);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            (yield* open(memory.storage)).shared(() => undefined),
          ),
        ),
      ).toBe(true);
      expect(memory.values).toEqual(before);
      expect(memory.control.mutations).toBe(0);
    }
  }),
);

test(
  "joined reads reject missing or malformed current tables and malformed shared headers without clearing data",
  Effect.gen(function* () {
    for (const key of [
      "account:oauth:v1",
      "account:attempts:v1",
      "account:enrollments:v1",
    ]) {
      for (const value of [undefined, { corrupt: true }]) {
        const memory = yield* keyedStorage();
        memory.restore(populated());

        if (value === undefined) memory.values.delete(key);
        else memory.values.set(key, value);
        const before = structuredClone(memory.values);
        const store = yield* open(memory.storage);
        expect(
          Exit.isFailure(yield* Effect.exit(store.update(() => undefined))),
        ).toBe(true);
        expect(memory.values).toEqual(before);
        expect(memory.control.mutations).toBe(0);
      }
    }

    for (const header of [
      null,
      { corrupt: true },
      {
        ...splitAccount(populated()).shared,
        publicRevocationGeneration: undefined,
      },
    ]) {
      const memory = yield* keyedStorage();
      memory.restore(populated());
      memory.values.set("account:shared:v1", header);
      const before = structuredClone(memory.values);
      const store = yield* open(memory.storage);
      const broadcaster = populated().channels[0];

      if (!broadcaster) return yield* Effect.die("Missing broadcaster");

      for (const operation of [
        store.shared(() => undefined),
        store.sendAttempt(() => undefined),
        store.channelDispatch(broadcaster.id, () => undefined),
        store.update(() => undefined),
      ])
        expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true);
      expect(memory.values).toEqual(before);
      expect(memory.control.mutations).toBe(0);
    }
  }),
);

for (const path of [
  "cached",
  "refresh",
  "validation",
  "failure",
  "unauthorized",
]) {
  test(
    `same-revision ${path} dispatch never reads unrelated channel or directory blobs`,
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        h.control.appExpires = 7200;
        yield* h.authorize();
        const token = yield* h.store.shared((state) => state.session);

        if (!token) return yield* Effect.die("Missing token");

        if (path === "refresh") h.time(token.expiresAt);

        if (path === "validation" || path === "failure")
          h.time(token.validatedAt + 3_600_000);

        if (path === "failure") h.control.appClient = "wrong-client";

        if (path === "unauthorized")
          h.control.result = { kind: "unauthorized" };
        h.memory.values.set("account:channel:v1/300", { corrupt: true });
        h.memory.values.set("account:oauth:v1", { corrupt: true });
        h.memory.values.set("account:enrollments:v1", { corrupt: true });
        h.memory.values.set("account:tombstone:v1/unrelated", {
          corrupt: true,
        });
        h.memory.traces.length = 0;
        const outcome = yield* h.account.dispatch(h.send(`path-${path}`));
        expect(outcome.kind).toBe(
          path === "failure" || path === "unauthorized" ? "retryable" : "sent",
        );

        const reads = h.memory.traces
          .filter((entry) => entry.operation === "get")
          .map((entry) => entry.key);

        expect(
          h.memory.traces.some((entry) => entry.operation === "list"),
        ).toBe(false);
        expect(
          reads.every((key) =>
            [
              "account:shared:v1",
              "account:attempts:v1",
              "account:channel:v1/200",
              "account:tombstone:v1/sub-200-1",
            ].includes(key),
          ),
        ).toBe(true);
        expect(reads.includes("account:channel:v1/200")).toBe(
          path !== "failure",
        );
        expect(h.control.mints).toBe(path === "refresh" ? 2 : 1);
        expect(h.control.sends).toBe(path === "failure" ? 0 : 1);
        expect(
          Exit.isFailure(yield* Effect.exit(h.store.update(() => undefined))),
        ).toBe(true);
        expect(h.memory.values.get("account:channel:v1/300")).toEqual({
          corrupt: true,
        });
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );
}

test(
  "same-revision construction and credential alarms require shared state only",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      h.memory.values.set("account:channel:v1/300", { corrupt: true });
      h.memory.values.set("account:attempts:v1", { corrupt: true });
      h.memory.values.set("account:oauth:v1", { corrupt: true });
      h.memory.values.set("account:enrollments:v1", { corrupt: true });
      h.memory.traces.length = 0;
      const reconstructed = yield* h.construct();
      h.time(initial + 1);
      h.consumeAlarm();
      yield* reconstructed.credentialAlarm();
      expect(
        h.memory.traces
          .filter((entry) => entry.operation === "get")
          .every((entry) => ["account:shared:v1"].includes(entry.key)),
      ).toBe(true);
      expect(h.memory.traces.some((entry) => entry.operation === "list")).toBe(
        false,
      );
      expect(h.nativeAlarmAt()).toBeGreaterThan(initial + 1);
      expect(
        Exit.isFailure(yield* Effect.exit(h.construct("changed-revision"))),
      ).toBe(true);
      expect(yield* h.store.shared((state) => state.revision)).toBe(
        "revision-one",
      );
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "joined updates write changed records and roll back record and native alarm changes together",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      h.memory.traces.length = 0;
      yield* h.store.update(() => undefined);
      expect(
        h.memory.traces.filter((entry) => entry.operation === "put"),
      ).toEqual([]);
      h.memory.traces.length = 0;
      yield* h.store.update((state) => {
        const prior = state.subscriptions["200"];

        if (prior)
          state.subscriptions["200"] = {
            ...prior,
            status: "webhook_callback_verification_pending",
          };
      });
      expect(
        h.memory.traces
          .filter((entry) => entry.operation === "put")
          .map((entry) => entry.key),
      ).toEqual(["account:channel:v1/200"]);
      const before = structuredClone(h.memory.values);
      const alarm = h.nativeAlarmAt();
      h.memory.control.failAt = h.memory.control.mutations + 2;
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            h.store.update((state) => {
              state.nextCredentialCheck = initial + 12;
            }),
          ),
        ),
      ).toBe(true);
      expect(h.memory.values).toEqual(before);
      expect(h.nativeAlarmAt()).toBe(alarm);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "reconstructed interrupted sends and expired relevant tombstones keep unrelated records untouched",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const proof = h.snapshot().subscriptions["200"];

      if (!proof) return yield* Effect.die("Missing proof");
      yield* h.store.update((state) => {
        state.revoked[proof.id] = { until: initial, reason: "retired" };
      });
      h.memory.values.set("account:tombstone:v1/unrelated", {
        until: initial,
        reason: "revoked",
      });
      h.control.sendGate = yield* Deferred.make<void>();
      h.control.sendStarted = yield* Deferred.make<void>();
      const input = h.send("interrupted-keyed");
      const sending = yield* h.account.dispatch(input).pipe(Effect.forkChild);

      yield* Deferred.await(h.control.sendStarted);
      expect(h.control.sends).toBe(1);
      expect(h.memory.values.has(`account:tombstone:v1/${proof.id}`)).toBe(
        false,
      );
      expect(h.memory.values.has("account:tombstone:v1/unrelated")).toBe(true);
      h.memory.values.set("account:channel:v1/300", { corrupt: true });
      const reconstructed = yield* h.construct();
      h.memory.traces.length = 0;
      expect(yield* reconstructed.service.dispatch(input)).toEqual({
        kind: "ambiguous",
      });
      expect(
        h.memory.traces
          .filter((entry) => entry.operation === "get")
          .every((entry) =>
            ["account:shared:v1", "account:attempts:v1"].includes(entry.key),
          ),
      ).toBe(true);
      expect(h.memory.traces.some((entry) => entry.operation === "list")).toBe(
        false,
      );
      yield* Deferred.succeed(h.control.sendGate, undefined);
      expect(yield* Fiber.join(sending)).toEqual({ kind: "ambiguous" });
      expect(h.control.sends).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "joined updates enforce independent record size limits without an aggregate account ceiling",
  Effect.gen(function* () {
    const state = populated();
    const proof = state.subscriptions["200"];

    if (!proof) return yield* Effect.die("Missing proof");

    for (let index = 0; index < 24; index++)
      state.subscriptions[`receipt-${index}`] = {
        ...proof,
        id: `proof-${index}`,
        binding: "b".repeat(8 * 1024),
      };
    expect(
      new TextEncoder().encode(JSON.stringify(state)).byteLength,
    ).toBeGreaterThan(120 * 1024);
    const memory = yield* keyedStorage();
    const store = yield* open(memory.storage);
    yield* store.update((record) => {
      Object.assign(record, state);
    });
    expect(yield* store.update((record) => structuredClone(record))).toEqual(
      state,
    );

    for (const oversize of [
      {
        ...state,
        subscriptions: { "200": { ...proof, binding: "b".repeat(121 * 1024) } },
      },
      { ...state, grants: { "100": ["s".repeat(121 * 1024)] } },
      {
        ...state,
        attempts: {
          waiting: {
            kind: "waiting",
            fingerprint: "f".repeat(121 * 1024),
            deadline: initial + 10,
            retainUntil: initial + 100,
            retryAt: initial + 1,
          },
        },
      },
    ]) {
      const before = structuredClone(memory.values);
      const alarm = memory.alarm();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.update((record) => {
              Object.assign(
                record,
                Schema.decodeUnknownSync(AccountState)(oversize),
              );
            }),
          ),
        ),
      ).toBe(true);
      expect(memory.values).toEqual(before);
      expect(memory.alarm()).toBe(alarm);
    }
  }),
);

test(
  "joined readers reject invalid membership positions and extra record facts without overwriting them",
  Effect.gen(function* () {
    for (const corruption of [
      {
        configured: [{ position: 1, member: { id: "200", login: "member" } }],
        public: [],
        subscription: null,
      },
      {
        configured: [{ position: 0, member: { id: "300", login: "member" } }],
        public: [],
        subscription: null,
      },
      {
        configured: [],
        public: [],
        subscription: null,
        discardedFact: "proof",
      },
    ]) {
      const memory = yield* keyedStorage();
      const store = yield* open(memory.storage);
      yield* store.shared(() => undefined);
      memory.values.set("account:channel:v1/200", corruption);
      const before = structuredClone(memory.values);
      expect(
        Exit.isFailure(yield* Effect.exit(store.update(() => undefined))),
      ).toBe(true);
      expect(memory.values).toEqual(before);
    }
  }),
);

test(
  "two broadcaster dispatches share reservations and keep original deadlines using their own record keys",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* h.store.shared((state) => {
        state.reservations = Array.from({ length: 19 }, () => ({
          channel: "other",
          at: initial,
        }));
      });
      h.memory.traces.length = 0;
      expect(
        (yield* h.account.dispatch(
          h.send("last-allowance", "200", initial + 40_000),
        )).kind,
      ).toBe("sent");
      expect(
        h.memory.traces.some((entry) => entry.key === "account:channel:v1/300"),
      ).toBe(false);
      h.memory.traces.length = 0;
      const input = h.send("other-waiting", "300", initial + 40_000);
      expect(yield* h.account.dispatch(input)).toEqual(
        Schema.decodeUnknownSync(DispatchOutcome)({
          kind: "retryable",
          retryAt: initial + 30_000,
        }),
      );
      expect(
        h.memory.traces.some((entry) => entry.key === "account:channel:v1/200"),
      ).toBe(false);
      expect(h.memory.traces.some((entry) => entry.operation === "list")).toBe(
        false,
      );

      const original = yield* h.store.sendAttempt(
        (state) => state.attempts[input.attemptId],
      );

      expect(original?.deadline).toBe(input.deadline);
      const reconstructed = yield* h.construct();
      h.time(initial + 30_000);
      expect((yield* reconstructed.service.dispatch(input)).kind).toBe("sent");

      const completed = yield* h.store.sendAttempt(
        (state) => state.attempts[input.attemptId],
      );

      expect(completed?.deadline).toBe(input.deadline);
      expect(completed?.retainUntil).toBe(original?.retainUntil);
      expect(h.control.sends).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);
