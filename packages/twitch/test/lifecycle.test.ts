import { expect } from "bun:test";

import {
  BroadcasterId,
  EnrollmentSession,
  type EnrollmentBegin,
} from "@arctools/twitch/server";
import { policy, ChannelRecord } from "@arctools/twitch/testing";
import { randomUUID as secureRandomUUID } from "@arctools/utils/http";
import { digest } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Option as EffectOption,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";

import { fixtureConfig, harness } from "./account-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const config = { ...fixtureConfig, senderKind: "bot" } as const;

type Harness = Effect.Success<ReturnType<typeof harness>>;

const intent = Effect.fnUntraced(function* () {
  return {
    session: EnrollmentSession.make(yield* digest(yield* secureRandomUUID)),
    state: `enroll.${yield* digest(yield* secureRandomUUID)}`,
    previousSession: null,
  } satisfies EnrollmentBegin;
});

const enroll = Effect.fnUntraced(function* (
  h: Harness,
  id = "400",
  login = "public_channel",
) {
  const input = yield* intent();
  yield* h.enrollment.begin(input);
  h.control.grantUser = id;
  h.control.grantLogin = login;
  h.control.grantScopes = ["channel:bot"];
  h.control.userIds.set(login, id);
  yield* h.enrollment.complete({
    ...input,
    outcome: { kind: "accepted", code: "owner" },
  });

  return input;
});

const ready = Effect.fnUntraced(function* (h: Harness) {
  h.time(h.now() + 1);
  yield* h.alarm;
});

const observe = Effect.fnUntraced(function* (
  h: Harness,
  id = "400",
  status = "enabled",
) {
  const record = h.snapshot().subscriptions[id];

  if (!record) return yield* Effect.die("Missing exact subscription");

  return yield* h.account.observeSubscription({
    ...record,
    broadcasterId: BroadcasterId.make(id),
    status,
  });
});

const run = <E>(name: string, body: (h: Harness) => Effect.Effect<void, E>) =>
  test(
    name,
    Effect.gen(function* () {
      const h = yield* harness(config);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        yield* body(h);
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );

run(
  "a recovery alarm defers to operator setup without invalidating its subscription listing",
  Effect.fnUntraced(function* (h) {
    yield* observe(h, "200", "chat_user_banned");
    h.time(h.now() + 60_000);
    h.control.listStarted = yield* Deferred.make<void>();
    h.control.listGate = yield* Deferred.make<void>();

    const setup = yield* h.account
      .setup("operator-digest")
      .pipe(Effect.forkChild);

    yield* Deferred.await(h.control.listStarted);
    yield* h.alarm;
    yield* Deferred.succeed(h.control.listGate, undefined);

    expect((yield* Fiber.join(setup)).status.setup).toBe("ready");
  }),
);

run(
  "Leave commits once, survives response loss and reconstruction, and cannot remove a reinstall",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    const old = h.send("old-work", "400");

    const expiry = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        h.snapshot().enrollments,
        (entry) => !!(entry.session === input.session),
      ),
    )?.expiresAt;

    const expected = { kind: "left", login: "public_channel" } as const;
    expect(yield* h.enrollment.leave(input.session)).toEqual(expected);
    const sequence = h.snapshot().publicRevocationGeneration;
    const restored = yield* h.construct();
    expect(yield* restored.enrollment.leave(input.session)).toEqual(expected);
    expect(yield* restored.enrollment.status(input.session)).toEqual(expected);
    expect(h.snapshot().publicRevocationGeneration).toBe(sequence);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          h.snapshot().enrollments,
          (entry) => !!(entry.session === input.session),
        ),
      )?.expiresAt,
    ).toBe(expiry);
    const next = yield* enroll(h);
    yield* ready(h);
    expect(
      (yield* restored.enrollment.leave(input.session).pipe(Effect.flip)).code,
    ).toBe("state");
    expect((yield* h.account.dispatch(old)).kind).toBe("rejected");
    expect((yield* h.account.dispatch(h.send("new-work", "400"))).kind).toBe(
      "sent",
    );
    expect(yield* h.enrollment.status(next.session)).toEqual({
      kind: "ready",
      login: "public_channel",
    });
  }),
);

run(
  "ban keeps authorization and exact negative authority, and a recovering owner can Leave",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    const old = h.send("before-ban", "400");
    const grants = h.snapshot().grants;
    yield* observe(h, "400", "chat_user_banned");
    const life = h.snapshot().lifecycle["400"];
    expect(life).toMatchObject({
      kind: "installed",
      recovery: { stage: 1, due: h.now() + 60_000 },
    });
    expect(h.snapshot().grants).toEqual(grants);
    expect(yield* observe(h)).toBeNull();
    expect((yield* h.account.dispatch(old)).kind).toBe("rejected");
    expect(yield* h.enrollment.status(input.session)).toEqual({
      kind: "recovering",
      login: "public_channel",
    });
    yield* h.enrollment.leave(input.session);
    expect(h.snapshot().lifecycle["400"]?.kind).toBe("removed");
    expect(h.snapshot().grants["100"]).toEqual(grants["100"]);
  }),
);

run(
  "missing sender authorization requires attention while preserving owner Leave",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    yield* h.store.shared((state) => {
      delete state.grants["100"];
    });
    expect(yield* h.enrollment.status(input.session)).toEqual({
      kind: "attention-required",
      login: "public_channel",
      reason: "sender-authorization-required",
    });
    expect(yield* h.enrollment.leave(input.session)).toEqual({
      kind: "left",
      login: "public_channel",
    });
  }),
);

run(
  "missing broadcaster authorization requires owner action and still permits Leave",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    yield* h.store.shared((state) => {
      delete state.grants["400"];
    });
    expect(yield* h.enrollment.status(input.session)).toEqual({
      kind: "attention-required",
      login: "public_channel",
      reason: "broadcaster-authorization-required",
    });
    expect((yield* h.enrollment.leave(input.session)).kind).toBe("left");
  }),
);

run(
  "missing sender setup and callback readiness require operator action rather than automatic recovery",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    const unavailable = yield* harness(config, false);
    unavailable.restore(h.snapshot());
    const restored = yield* unavailable.construct();

    expect(yield* restored.enrollment.status(input.session)).toEqual({
      kind: "attention-required",
      login: "public_channel",
      reason: "ingress-required",
    });
    expect((yield* restored.enrollment.leave(input.session)).kind).toBe("left");
    yield* h.store.shared((state) => {
      state.sender = null;
    });
    expect(yield* h.enrollment.status(input.session)).toEqual({
      kind: "attention-required",
      login: "public_channel",
      reason: "setup-required",
    });
    expect((yield* h.enrollment.leave(input.session)).kind).toBe("left");
  }),
);

run(
  "configured overlap stays removed across ordinary setup and fresh owner OAuth reinstalls it",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h, "200", "fixture_channel");
    yield* ready(h);
    yield* h.enrollment.leave(input.session);
    yield* h.account.setup("operator");
    expect(
      EffectArray.map((yield* h.account.status).channels, (entry) => entry.id),
    ).not.toContain(BroadcasterId.make("200"));
    expect(h.snapshot().lifecycle["200"]?.kind).toBe("removed");
    const fresh = yield* enroll(h, "200", "fixture_channel");
    yield* ready(h);
    expect(yield* h.enrollment.status(fresh.session)).toEqual({
      kind: "ready",
      login: "fixture_channel",
    });
    expect(
      EffectArray.map((yield* h.account.status).channels, (entry) => entry.id),
    ).toContain(BroadcasterId.make("300"));
  }),
);

run(
  "leaving the sender's channel preserves sender roles, credentials and unrelated channels",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h, "100", "fixture_sender");
    yield* ready(h);
    const before = h.snapshot();
    yield* h.enrollment.leave(input.session);
    const after = h.snapshot();
    expect(after.grants["100"]).toEqual(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(before.grants["100"]),
          (effectNativeValue0) =>
            EffectArray.filter(
              effectNativeValue0,
              (scope) => !!(scope !== "channel:bot"),
            ),
        ),
      ),
    );
    expect(after.sender).toEqual(before.sender);
    expect(after.session).toEqual(before.session);
    expect((yield* h.account.dispatch(h.send("other-channel"))).kind).toBe(
      "sent",
    );
  }),
);

run(
  "multiple retired installations keep independent durable DELETE obligations through failure and reconstruction",
  Effect.fnUntraced(function* (h) {
    h.control.failRemove = true;
    const first = yield* enroll(h);
    yield* ready(h);
    const old = h.snapshot().subscriptions["400"]?.id ?? "missing";
    yield* h.enrollment.leave(first.session);
    const second = yield* enroll(h);
    yield* ready(h);
    const newer = h.snapshot().subscriptions["400"]?.id ?? "missing-newer";
    yield* h.enrollment.leave(second.session);
    expect(old).not.toBe(newer);
    expect(h.snapshot().revoked[old]?.deleteDue).not.toBeNull();
    expect(h.snapshot().revoked[newer]?.deleteDue).not.toBeNull();
    h.time(h.now() + 60_001);
    const restored = yield* h.construct();
    yield* restored.credentialAlarm;
    expect(EffectArray.map(h.control.remote, (entry) => entry.id)).toContain(
      old,
    );
    h.control.failRemove = false;
    h.time(h.now() + 60_001);
    yield* restored.credentialAlarm;
    expect(
      EffectArray.map(h.control.remote, (entry) => entry.id),
    ).not.toContain(old);
    expect(
      EffectArray.map(h.control.remote, (entry) => entry.id),
    ).not.toContain(newer);
    expect(h.snapshot().revoked[old]?.deleteDue).toBeNull();
    expect(h.snapshot().revoked[newer]?.deleteDue).toBeNull();
  }),
);

run(
  "an uncertain create appearing after an empty sweep and the replay window is durably cleaned",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    h.control.failCreate = true;
    yield* ready(h);

    const unknown = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        h.control.remote,
        (entry) => !!(entry.condition.broadcaster_user_id === "400"),
      ),
    );

    if (!unknown) return yield* Effect.die("Missing uncertain remote success");
    h.control.remote = EffectArray.filter(
      h.control.remote,
      (entry) => !!(entry !== unknown),
    );
    yield* h.enrollment.leave(input.session);
    h.time(h.snapshot().sweepAt ?? 0);
    const restored = yield* h.construct();
    yield* restored.credentialAlarm;
    const nextSweep = h.snapshot().sweepAt ?? 0;
    expect(nextSweep).toBeGreaterThan(h.now());
    h.control.remote.push(unknown);
    h.time(nextSweep + policy.revocationMs);
    yield* restored.credentialAlarm;
    expect(h.snapshot().revoked[unknown.id]?.deleteDue).not.toBeNull();
    h.time(h.now() + 1);
    yield* restored.credentialAlarm;
    expect(
      EffectArray.some(
        h.control.remote,
        (entry) => !!(entry.id === unknown.id),
      ),
    ).toBeFalse();
    expect(h.snapshot().lifecycle["400"]?.kind).toBe("removed");
  }),
);

run(
  "failed unrelated deletes cannot exhaust a channel's creation lease",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    h.control.failRemove = true;
    h.control.removeElapsedMs = 4000;

    for (let index = 0; index < 32; index++)
      h.control.remote.push({
        id: `orphan-${index}`,
        type: "channel.chat.message",
        version: "1",
        status: "enabled",
        condition: {
          broadcaster_user_id: String(1000 + index),
          user_id: "100",
        },
        transport: {
          method: "webhook",
          callback: "https://fixture.invalid/webhooks/twitch",
        },
      });

    const before = h.now();
    yield* ready(h);
    expect(yield* h.enrollment.status(input.session)).toEqual({
      kind: "ready",
      login: "public_channel",
    });
    expect(h.now() - before).toBeLessThanOrEqual(16_001);
    expect(EffectRecord.keys(h.snapshot().revoked)).toHaveLength(32);
  }),
);

run(
  "a throttled sweep persists a future alarm across reconstruction",
  Effect.fnUntraced(function* (h) {
    const blocked = h.now() + 3_600_000;
    yield* h.store.shared((state) => {
      state.apiBlockedUntil = blocked;
      state.sweepAt = h.now();
      state.sweepLease = null;
    });
    h.consumeAlarm();
    yield* h.alarm;
    expect(h.snapshot().sweepAt).toBe(blocked);
    expect(h.nativeAlarmAt() ?? 0).toBeGreaterThan(h.now());
    const restored = yield* h.construct();
    yield* restored.credentialAlarm;
    expect(h.snapshot().sweepAt).toBe(blocked);
  }),
);

run(
  "a DELETE throttle prevents the already-claimed sweep from listing in the same turn",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    yield* h.enrollment.leave(input.session);
    h.time(h.snapshot().sweepAt ?? 0);
    h.control.failRemove = true;
    h.control.removeRetryAt = h.now() + 3_600_000;
    const lists = h.control.lists;

    yield* h.alarm;
    expect(h.control.lists).toBe(lists);
    expect(h.snapshot().sweepAt ?? 0).toBeGreaterThanOrEqual(
      h.control.removeRetryAt,
    );
  }),
);

run(
  "a conflicting DELETE throttle prevents a replacement create in the same turn",
  Effect.fnUntraced(function* (h) {
    yield* enroll(h);
    yield* ready(h);
    yield* observe(h, "400", "chat_user_banned");
    h.time(h.now() + 60_000);
    h.control.failRemove = true;
    h.control.removeRetryAt = h.now() + 3_600_000;
    const creates = h.control.creates;

    yield* h.alarm;
    expect(h.control.creates).toBe(creates);
    expect(h.snapshot().apiBlockedUntil).toBe(h.control.removeRetryAt);
    const life = h.snapshot().lifecycle["400"];

    expect(
      life?.kind === "installed" ? life.recovery?.due : 0,
    ).toBeGreaterThanOrEqual(h.control.removeRetryAt);
  }),
);

run(
  "shared throttling defers due channels without consuming their recovery stage",
  Effect.fnUntraced(function* (h) {
    yield* enroll(h);
    yield* enroll(h, "500", "second_channel");
    yield* ready(h);
    yield* observe(h, "400", "chat_user_banned");
    yield* observe(h, "500", "chat_user_banned");
    h.time(h.now() + 60_000);
    const blocked = h.now() + 600_000;

    yield* h.store.shared((state) => {
      state.apiBlockedUntil = blocked;
    });
    const creates = h.control.creates;

    yield* h.alarm;
    expect(h.control.creates).toBe(creates);

    for (const id of ["400", "500"])
      expect(h.snapshot().lifecycle[id]).toMatchObject({
        kind: "installed",
        recovery: { stage: 1, due: blocked },
      });
  }),
);

run(
  "one failing channel cannot consume another channel's recovery schedule",
  Effect.fnUntraced(function* (h) {
    yield* enroll(h);
    const second = yield* enroll(h, "500", "second_channel");
    h.control.failedChannels.add("400");
    yield* ready(h);
    expect(yield* h.enrollment.status(second.session)).toEqual({
      kind: "ready",
      login: "second_channel",
    });
    expect(h.snapshot().grants["400"]).toEqual(["channel:bot"]);
    expect(h.snapshot().lifecycle["400"]).toMatchObject({
      kind: "installed",
      recovery: { stage: 1 },
    });
  }),
);

run(
  "an issued send may finish before Leave commits, and every later part rejects",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    const part = h.send("part-one", "400");
    const next = { ...part, attemptId: h.send("part-two", "400").attemptId };
    h.control.sendGate = yield* Deferred.make<void>();
    h.control.sendStarted = yield* Deferred.make<void>();
    const sending = yield* h.account.dispatch(part).pipe(Effect.forkChild);
    yield* Deferred.await(h.control.sendStarted);

    const leaving = yield* h.enrollment
      .leave(input.session)
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    expect(h.snapshot().lifecycle["400"]?.kind).toBe("installed");
    yield* Deferred.succeed(h.control.sendGate, undefined);
    expect((yield* Fiber.join(sending)).kind).toBe("sent");
    expect((yield* Fiber.join(leaving)).kind).toBe("left");
    expect((yield* h.account.dispatch(next)).kind).toBe("rejected");
    expect(h.control.sends).toBe(1);
  }),
);

run(
  "expired, pending and replaced capabilities cannot mutate membership",
  Effect.fnUntraced(function* (h) {
    const pending = yield* intent();
    yield* h.enrollment.begin(pending);
    const before = h.snapshot();
    expect(
      (yield* h.enrollment.leave(pending.session).pipe(Effect.flip)).code,
    ).toBe("state");
    expect(h.snapshot()).toEqual(before);
    const input = yield* enroll(h);
    yield* ready(h);

    const expiry =
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          h.snapshot().enrollments,
          (entry) => !!(entry.session === input.session),
        ),
      )?.expiresAt ?? 0;

    h.time(expiry);
    expect(
      (yield* h.enrollment.leave(input.session).pipe(Effect.flip)).code,
    ).toBe("state");
    expect(h.snapshot().lifecycle["400"]?.kind).toBe("installed");
  }),
);

run(
  "legacy keyed installs gain one stable opaque identity and keep their exact proof across reconstruction",
  Effect.fnUntraced(function* (h) {
    const raw = h.memory.values.get("account:channel:v1/200");
    const row = yield* Schema.decodeUnknownEffect(ChannelRecord)(raw);
    const { lifecycle: _lifecycle, ...legacy } = row;
    h.memory.values.set("account:channel:v1/200", legacy);
    yield* h.store.shared((state) => {
      state.lifecycleVersion = 0;
    });
    const first = yield* h.construct();
    const life = h.snapshot().lifecycle["200"];
    expect(life?.kind).toBe("installed");
    const second = yield* h.construct();
    expect(h.snapshot().lifecycle["200"]).toEqual(life);
    expect((yield* first.service.dispatch(h.send("migrated-first"))).kind).toBe(
      "sent",
    );
    h.time(h.now() + 1000);
    expect(
      (yield* second.service.dispatch(h.send("migrated-second"))).kind,
    ).toBe("sent");
  }),
);

run(
  "a held old list cannot retire a replacement installation",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    h.control.listGate = yield* Deferred.make<void>();
    h.control.listStarted = yield* Deferred.make<void>();

    const settingUp = yield* h.account
      .setup("operator")
      .pipe(Effect.result, Effect.forkChild);

    yield* Deferred.await(h.control.listStarted);
    yield* h.enrollment.leave(input.session);
    const next = yield* enroll(h);
    h.control.listStarted = null;
    yield* Deferred.succeed(h.control.listGate, undefined);
    yield* Fiber.join(settingUp);
    h.control.listGate = null;
    yield* ready(h);
    const record = h.snapshot().subscriptions["400"];
    expect(record).toBeDefined();
    expect(h.snapshot().revoked[record?.id ?? "missing"]).toBeUndefined();
    expect(yield* h.enrollment.status(next.session)).toEqual({
      kind: "ready",
      login: "public_channel",
    });
  }),
);

run(
  "fresh reauthorization retires old negative authority before a stale signed removal",
  Effect.fnUntraced(function* (h) {
    yield* enroll(h);
    yield* ready(h);
    const old = h.snapshot().subscriptions["400"];

    if (!old) return yield* Effect.die("Missing old proof");
    yield* observe(h, "400", "chat_user_banned");
    const next = yield* enroll(h);
    yield* h.account.observeSubscription({
      ...old,
      broadcasterId: BroadcasterId.make("400"),
      status: "authorization_revoked",
    });
    expect(h.snapshot().lifecycle["400"]?.kind).toBe("installed");
    yield* ready(h);
    expect(yield* h.enrollment.status(next.session)).toEqual({
      kind: "ready",
      login: "public_channel",
    });
  }),
);

run(
  "Leave wins while credentials are held before send issuance",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);
    const old = h.send("not-issued", "400");
    yield* h.store.shared((state) => {
      state.session = null;
    });
    h.control.mintGate = yield* Deferred.make<void>();
    h.control.mintStarted = yield* Deferred.make<void>();
    const dispatch = yield* h.account.dispatch(old).pipe(Effect.forkChild);
    yield* Deferred.await(h.control.mintStarted);
    expect((yield* h.enrollment.leave(input.session)).kind).toBe("left");
    yield* Deferred.succeed(h.control.mintGate, undefined);
    expect((yield* Fiber.join(dispatch)).kind).toBe("rejected");
    expect(h.control.sends).toBe(0);
  }),
);

run(
  "left replay records do not consume enrollment or installed-member capacity",
  Effect.fnUntraced(function* (h) {
    const seed = yield* intent();
    yield* h.store.update((state) => {
      for (let index = 0; index < 45; index++)
        state.lifecycle[String(1000 + index)] = {
          kind: "removed",
          sequence: 0,
        };
      state.enrollments = Array.from({ length: 45 }, (_, index) => ({
        session: EnrollmentSession.make(
          EffectString.padStart(64, "0")(index.toString(16)),
        ),
        nonce: seed.state,
        revision: "revision-one",
        generation: state.authGeneration,
        publicRevocationGeneration: 0,
        expiresAt: h.now() + policy.enrollmentSessionMs,
        phase: {
          kind: "left",
          broadcasterId: BroadcasterId.make(String(1000 + index)),
          login: "retired",
        },
      }));
    });
    expect(
      EffectArray.filter(
        [...h.memory.values.keys()],
        (key) => !!EffectString.startsWith("account:left:v1/")(key),
      ),
    ).toHaveLength(45);
    const fresh = yield* enroll(h);
    yield* ready(h);
    expect(yield* h.enrollment.status(fresh.session)).toEqual({
      kind: "ready",
      login: "public_channel",
    });
    expect(
      yield* h.enrollment.leave(
        EnrollmentSession.make(EffectString.repeat(64)("0")),
      ),
    ).toEqual({ kind: "left", login: "retired" });
  }),
);

run(
  "a configuration revision preserves left replay through its original expiry",
  Effect.fnUntraced(function* (h) {
    const input = yield* enroll(h);
    yield* ready(h);

    const expiry =
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          h.snapshot().enrollments,
          (entry) => !!(entry.session === input.session),
        ),
      )?.expiresAt ?? 0;

    yield* h.enrollment.leave(input.session);
    const revised = yield* h.construct("new-config-revision");
    expect(yield* revised.enrollment.status(input.session)).toEqual({
      kind: "left",
      login: "public_channel",
    });
    expect(yield* revised.enrollment.leave(input.session)).toEqual({
      kind: "left",
      login: "public_channel",
    });
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          h.snapshot().enrollments,
          (entry) => !!(entry.session === input.session),
        ),
      )?.expiresAt,
    ).toBe(expiry);
    h.time(expiry);
    expect(
      (yield* revised.enrollment.leave(input.session).pipe(Effect.flip)).code,
    ).toBe("state");
  }),
);
