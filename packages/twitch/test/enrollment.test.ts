import { expect } from "bun:test";

import {
  BroadcasterId,
  EnrollmentSession,
  type EnrollmentBegin,
} from "@arctools/twitch/server";
import {
  AccountState,
  desiredChannels,
  policy,
} from "@arctools/twitch/testing";
import { digest } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import { Clock, Deferred, Effect, Fiber, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { fixtureConfig, harness, initial } from "./account-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const production = {
  ...fixtureConfig,
  kind: "production",
} satisfies Parameters<typeof harness>[0];

export const enrollmentInput = Effect.fnUntraced(function* (
  label = crypto.randomUUID(),
) {
  return {
    session: EnrollmentSession.make(yield* digest(`session-${label}`)),
    previousSession: null,
    state: `enroll.${yield* digest(`nonce-${label}`)}`,
  } satisfies EnrollmentBegin;
});

const publicGrant = (
  h: Effect.Success<ReturnType<typeof harness>>,
  login = "public_channel",
  id = "400",
) => {
  h.control.grantLogin = login;
  h.control.grantUser = id;
  h.control.grantScopes = ["channel:bot"];
  h.control.userIds.set(login, id);
};

const enroll = Effect.fnUntraced(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
) {
  const input = yield* enrollmentInput();
  yield* h.enrollment.begin(input);
  publicGrant(h);
  yield* h.enrollment.complete({
    ...input,
    outcome: { kind: "accepted", code: "public-code" },
  });

  return input;
});

const snapshot = (h: Effect.Success<ReturnType<typeof harness>>) =>
  Schema.decodeUnknownSync(AccountState)(h.snapshot());

for (const kind of ["personal", "test"] as const) {
  test(
    `production public membership stays dormant after a ${kind} transition and can be reauthorized in production`,
    Effect.gen(function* () {
      const source = yield* harness(production);
      yield* Effect.gen(function* () {
        yield* source.authorize();
        yield* enroll(source);
        source.time(initial + 1);
        yield* source.alarm();
      }).pipe(Effect.provideService(Clock.Clock, source.clock));

      const h = yield* harness({
        ...fixtureConfig,
        kind,
        channelLogins: [fixtureConfig.senderLogin],
      });

      h.restore(snapshot(source));
      h.control.remote = structuredClone(source.control.remote);
      h.control.creates = source.control.creates;
      yield* Effect.gen(function* () {
        const restored = yield* h.construct(`${kind}-revision`);
        yield* h.authorize(restored.service);
        expect(
          (yield* restored.service.status()).channels.map((c) => c.login),
        ).toEqual([fixtureConfig.senderLogin]);
        expect(snapshot(h).publicMembers).toEqual(
          snapshot(source).publicMembers,
        );
        expect(h.control.creates).toBe(source.control.creates + 1);
        const before = snapshot(h);
        const publicRecord = snapshot(source).subscriptions["400"];

        if (!publicRecord) return yield* Effect.die("Missing public receipt");
        yield* restored.service.observeSubscription({
          ...publicRecord,
          broadcasterId: BroadcasterId.make("400"),
          status: "authorization_revoked",
        });
        expect(snapshot(h)).toEqual(before);
        expect(
          (yield* restored.service.dispatch(h.send("dormant", "400"))).kind,
        ).toBe("rejected");
        const creates = h.control.creates;
        yield* restored.service.setup("operator-digest");
        h.time(initial + 1);
        yield* restored.credentialAlarm();
        expect(h.control.creates).toBe(creates);
        expect(h.control.sends).toBe(0);
      }).pipe(Effect.provideService(Clock.Clock, h.clock));

      const returned = yield* harness(production);
      returned.restore(snapshot(h));
      returned.control.creates = h.control.creates;
      yield* Effect.gen(function* () {
        const restored = yield* returned.construct("returned-production");
        yield* returned.authorize(restored.service);
        expect(
          (yield* restored.service.status()).channels.map((c) => c.login),
        ).toEqual(["public_channel", ...production.channelLogins]);
        expect(snapshot(returned).publicMembers).toEqual(
          snapshot(source).publicMembers,
        );
        expect(returned.control.creates).toBe(h.control.creates + 2);
        expect(
          (yield* restored.service.dispatch(
            returned.send("before-reauth", "400"),
          )).kind,
        ).toBe("rejected");
        const input = yield* enrollmentInput();
        yield* restored.enrollment.begin(input);
        publicGrant(returned);
        yield* restored.enrollment.complete({
          ...input,
          outcome: { kind: "accepted", code: "reauthorize" },
        });
        returned.time(initial + 1);
        yield* restored.credentialAlarm();
        expect(yield* restored.enrollment.status(input.session)).toEqual({
          kind: "ready",
          login: "public_channel",
        });
        expect(returned.control.creates).toBe(h.control.creates + 3);
        expect(
          (yield* restored.service.dispatch(
            returned.send("after-reauth", "400"),
          )).kind,
        ).toBe("sent");
      }).pipe(Effect.provideService(Clock.Clock, returned.clock));
    }),
  );
}

test(
  "public membership preserves sender, revision, other grants and shared limits and setup retains membership",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* h.account.dispatch(h.send("before-public"));
      const before = snapshot(h);
      const input = yield* enroll(h);
      const saved = snapshot(h);
      expect(saved.sender).toEqual(before.sender);
      expect(saved.revision).toBe(before.revision);
      expect(saved.authGeneration).toBe(before.authGeneration);
      expect(saved.grants).toEqual({
        ...before.grants,
        "400": ["channel:bot"],
      });
      expect(saved.attempts).toEqual(before.attempts);
      expect(saved.reservations).toEqual(before.reservations);
      expect(saved.repair.kind).toBe("scheduled");
      expect(h.nativeAlarmAt()).toBe(initial + 1);
      expect(JSON.stringify(h.snapshot())).not.toContain("canary-user-token");
      expect(JSON.stringify(h.snapshot())).not.toContain(input.state);
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "pending",
      });
      h.time(initial + 1);
      h.consumeAlarm();
      yield* h.alarm();
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(
        (yield* h.account.dispatch(h.send("public-send", "400"))).kind,
      ).toBe("sent");
      expect(
        (yield* h.account.setup("operator-digest")).status.channels.map(
          (channel) => String(channel.id),
        ),
      ).toEqual(["400", "200", "300"]);
      expect(snapshot(h).publicMembers).toEqual([
        {
          id: BroadcasterId.make("400"),
          login: "public_channel",
          revocationGeneration: 0,
        },
      ]);
      const exchanges = h.control.exchanges;
      expect(
        (yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "replay" } })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      expect(h.control.exchanges).toBe(exchanges);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "wrong session and state cannot consume valid authorization or denial; expiry and denial exchange nothing",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enrollmentInput();
      const other = yield* enrollmentInput();
      yield* h.enrollment.begin(input);
      const before = snapshot(h);
      const exchanges = h.control.exchanges;

      for (const attempt of [
        { ...input, session: other.session },
        { ...input, state: other.state },
      ]) {
        for (const outcome of [
          { kind: "denied" },
          { kind: "accepted", code: "secret" },
        ] satisfies Parameters<typeof h.enrollment.complete>[0]["outcome"][]) {
          expect(
            (yield* h.enrollment
              .complete({ ...attempt, outcome })
              .pipe(Effect.flip)).code,
          ).toBe("state");
        }
      }

      expect(snapshot(h).enrollments).toEqual(before.enrollments);
      expect(
        yield* h.enrollment.complete({ ...input, outcome: { kind: "denied" } }),
      ).toEqual({ kind: "failed", reason: "denied" });
      expect(snapshot(h).publicMembers).toEqual([]);
      expect(snapshot(h).grants).toEqual(before.grants);
      const expired = yield* enrollmentInput();
      yield* h.enrollment.begin(expired);
      h.time(initial + policy.oauthMs);
      expect(
        (yield* h.enrollment
          .complete({
            ...expired,
            outcome: { kind: "accepted", code: "secret" },
          })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      expect(yield* h.enrollment.status(expired.session)).toEqual({
        kind: "failed",
        reason: "expired",
      });
      expect(h.control.exchanges).toBe(exchanges);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

for (const mismatch of [
  "client",
  "identity",
  "login",
  "scopes",
  "expiry",
  "resolved-user",
]) {
  test(
    `public callback rejects ${mismatch} and never changes sender or grants`,
    Effect.gen(function* () {
      const h = yield* harness(production);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        const input = yield* enrollmentInput();
        yield* h.enrollment.begin(input);
        const before = snapshot(h);
        publicGrant(h);

        switch (mismatch) {
          case "client":
            h.control.grantClient = "wrong";
            break;
          case "identity":
            h.control.grantUser = "wrong";
            break;
          case "login":
            h.control.grantLogin = "UPPERCASE";
            break;
          case "scopes":
            h.control.grantScopes = [];
            break;
          case "expiry":
            h.control.grantExpires = 0;
            break;
          case "resolved-user":
            h.control.userIds.set("public_channel", "different");
            break;
        }

        yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "secret" } })
          .pipe(Effect.flip);
        expect(snapshot(h).sender).toEqual(before.sender);
        expect(snapshot(h).grants).toEqual(before.grants);
        expect(snapshot(h).publicMembers).toEqual([]);
        expect(yield* h.enrollment.status(input.session)).toEqual({
          kind: "failed",
          reason: "authorization-failed",
        });
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );
}

test(
  "one claim exchanges once and lease, generation, revision and expiry fence late completion",
  Effect.gen(function* () {
    for (const fence of ["lease", "generation", "revision", "expiry"]) {
      const h = yield* harness(production);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        const input = yield* enrollmentInput();
        yield* h.enrollment.begin(input);
        publicGrant(h);
        h.control.exchangeGate = yield* Deferred.make<void>();
        const exchanges = h.control.exchanges;

        const complete = yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "secret" } })
          .pipe(Effect.flip, Effect.forkChild);

        for (let i = 0; i < 100 && h.control.exchanges === exchanges; i++)
          yield* Effect.yieldNow;
        expect(h.control.exchanges).toBe(exchanges + 1);
        expect(
          (yield* h.enrollment
            .complete({
              ...input,
              outcome: { kind: "accepted", code: "second" },
            })
            .pipe(Effect.flip)).code,
        ).toBe("state");

        if (fence === "lease") h.time(initial + policy.enrollmentLeaseMs);

        if (fence === "expiry") h.time(initial + policy.oauthMs);

        if (fence === "revision") yield* h.construct("new-revision");

        if (fence === "generation") {
          const record = snapshot(h).subscriptions["200"];

          if (!record) return yield* Effect.die("Missing fixture subscription");
          yield* h.account.observeSubscription({
            ...record,
            broadcasterId: BroadcasterId.make("200"),
            status: "user_removed",
          });
        }

        yield* Deferred.succeed(h.control.exchangeGate, undefined);
        expect((yield* Fiber.join(complete)).code).toBe("state");
        expect(snapshot(h).publicMembers).toEqual([]);
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }
  }),
);

test(
  "intent capacity is reclaimed by TTL and browser rotation; channel capacity is admitted atomically",
  Effect.gen(function* () {
    const identity = {
      ...production,
      channelLogins: Array.from(
        { length: 31 },
        (_, i) => `fixture_channel_${i}`,
      ),
    };

    const h = yield* harness(identity);
    yield* Effect.gen(function* () {
      yield* h.authorize();

      const intents = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => `capacity-${i}`),
        (label) => enrollmentInput(label),
      );

      for (const input of intents) yield* h.enrollment.begin(input);
      const overflow = yield* enrollmentInput();
      expect((yield* h.enrollment.begin(overflow).pipe(Effect.flip)).code).toBe(
        "capacity",
      );
      const first = intents[0];
      const second = intents[1];

      if (!first || !second)
        return yield* Effect.die("Missing capacity intents");
      const replacement = { ...overflow, previousSession: first.session };
      yield* h.enrollment.begin(replacement);
      expect(snapshot(h).enrollments.length).toBe(8);
      h.control.usersGate = yield* Deferred.make<void>();
      publicGrant(h, "public_a", "800");
      const users = h.control.usersTokens.length;

      const a = yield* h.enrollment
        .complete({ ...replacement, outcome: { kind: "accepted", code: "a" } })
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.usersTokens.length === users; i++)
        yield* Effect.yieldNow;
      publicGrant(h, "public_b", "900");

      const b = yield* h.enrollment
        .complete({ ...second, outcome: { kind: "accepted", code: "b" } })
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.usersTokens.length < users + 2; i++)
        yield* Effect.yieldNow;
      expect(h.control.usersTokens.length).toBe(users + 2);
      yield* Deferred.succeed(h.control.usersGate, undefined);
      const outcomes = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(outcomes.filter(Result.isSuccess).length).toBe(1);
      expect(
        outcomes.flatMap((result) =>
          Result.isFailure(result) ? [result.failure.code] : [],
        ),
      ).toEqual(["capacity"]);
      expect(desiredChannels(snapshot(h), production.kind).length).toBe(32);
      expect(snapshot(h).publicMembers.length).toBe(1);
      const member = snapshot(h).publicMembers[0];

      if (!member) return yield* Effect.die("Missing admitted public member");
      h.control.usersGate = null;
      const reauth = yield* enrollmentInput();
      yield* h.enrollment.begin(reauth);
      publicGrant(h, member.login, member.id);
      yield* h.enrollment.complete({
        ...reauth,
        outcome: { kind: "accepted", code: "reauth" },
      });
      expect(desiredChannels(snapshot(h), production.kind).length).toBe(32);
      h.time(initial + policy.oauthMs);
      yield* h.enrollment.begin(yield* enrollmentInput());
      expect(
        snapshot(h).enrollments.filter(
          (entry) => entry.phase.kind === "pending",
        ).length,
      ).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "current keyed membership survives reconstruction and revision while previous sessions require reauthorization",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();

      const input = yield* enroll(h);
      const installed = snapshot(h);
      h.restoreRaw(Schema.encodeSync(AccountState)(installed));
      const reconstructed = yield* h.construct();
      expect((yield* reconstructed.service.status()).setup).toBe("pending");
      expect(snapshot(h)).toEqual({
        ...installed,
        nextCredentialCheck: initial + 1,
      });
      const revised = yield* h.construct("new-configuration");
      expect(snapshot(h).publicMembers.length).toBe(1);
      expect(snapshot(h).grants).toEqual({});
      expect(yield* revised.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "authorization-required",
      });
      expect(
        (yield* revised.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "old" } })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      yield* h.authorize(revised.service);
      const next = yield* enrollmentInput();
      yield* revised.enrollment.begin(next);
      publicGrant(h);
      yield* revised.enrollment.complete({
        ...next,
        outcome: { kind: "accepted", code: "new" },
      });
      expect(snapshot(h).publicMembers.length).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "reconstruction and alarms repair unknown receipts without polling, then require confirmed enabled observations",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.time(initial + 1);
      h.control.failCreate = true;
      yield* h.alarm();

      const unknown = h.control.remote.find(
        (sub) => sub.condition.broadcaster_user_id === "400",
      )?.id;

      expect(unknown).toBeDefined();
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
      const recovered = yield* h.construct();
      h.control.failCreate = false;
      h.control.subscriptionStatus = "webhook_callback_verification_pending";
      h.time(initial + 1 + policy.repairRetryMs);
      h.consumeAlarm();
      yield* recovered.credentialAlarm();
      expect(h.control.remote.some((sub) => sub.id === unknown)).toBeFalse();
      const record = snapshot(h).subscriptions["400"];

      if (!record)
        return yield* Effect.die("Missing repaired subscription receipt");
      expect(yield* recovered.enrollment.status(input.session)).toEqual({
        kind: "pending",
      });
      yield* recovered.service.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "webhook_callback_verification_pending",
      });
      expect(yield* recovered.enrollment.status(input.session)).toEqual({
        kind: "pending",
      });
      yield* recovered.service.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "enabled",
      });
      expect(yield* recovered.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      h.time(h.now() + policy.repairRetryMs);
      yield* recovered.credentialAlarm();
      expect(snapshot(h).repair).toEqual({ kind: "idle" });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "repair retries are bounded and app credential invalidation preserves its native alarm",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.result = { kind: "unauthorized" };
      yield* h.account.dispatch(h.send("invalidate-before-repair"));
      expect(snapshot(h).session).toBeNull();
      expect(h.nativeAlarmAt()).toBe(initial + 1);
      h.control.failCreate = true;

      for (let attempt = 0; attempt < policy.maxRepairAttempts; attempt++) {
        h.time(initial + 1 + attempt * policy.repairRetryMs);
        h.consumeAlarm();
        yield* h.alarm();
      }

      expect(snapshot(h).repair).toEqual({ kind: "required" });
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "repair-required",
      });
      const creates = h.control.creates;
      h.time(h.now() + policy.repairRetryMs);
      yield* h.alarm();
      expect(h.control.creates).toBe(creates);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "revocation stops readiness and a new grant reinstalls without replacing sender; personal environments deny mutation",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm();
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public subscription");
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "authorization-required",
      });
      expect(
        (yield* h.account.dispatch(h.send("revoked-public", "400"))).kind,
      ).toBe("rejected");
      yield* h.authorize();
      const reinstalled = yield* enroll(h);
      h.time(h.now() + 1);
      yield* h.alarm();
      expect(yield* h.enrollment.status(reinstalled.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(snapshot(h).sender?.id).toBe("100");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));

    const personal = yield* harness({
      ...fixtureConfig,
      kind: "personal",
      stage: "staging",
      senderLogin: "personal",
      channelLogins: ["personal"],
    });

    const input = yield* enrollmentInput();
    const before = personal.snapshot();
    expect(
      (yield* personal.enrollment.begin(input).pipe(Effect.flip)).code,
    ).toBe("configuration");
    expect(
      (yield* personal.enrollment
        .complete({ ...input, outcome: { kind: "accepted", code: "secret" } })
        .pipe(Effect.flip)).code,
    ).toBe("configuration");
    expect(personal.snapshot()).toEqual(before);
    expect(personal.control.exchanges).toBe(0);
  }),
);

test(
  "a held repair preserves a newer enrollment's repair id and schedule across completion and retries",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      const old = snapshot(h).repair;

      if (old.kind !== "scheduled") return yield* Effect.die("Missing repair");
      expect(old.id.length).toBeGreaterThan(0);
      h.control.listGate = yield* Deferred.make<void>();
      h.time(initial + 1);
      const lists = h.control.lists;
      const repair = yield* h.alarm().pipe(Effect.forkChild);

      for (let i = 0; i < 100 && h.control.lists === lists; i++)
        yield* Effect.yieldNow;
      expect(h.control.lists).toBe(lists + 1);
      const claimed = snapshot(h).repair;
      expect(claimed).toMatchObject({
        kind: "scheduled",
        id: old.id,
        attempts: 1,
      });

      const input = yield* enrollmentInput();
      yield* h.enrollment.begin(input);
      publicGrant(h, "new_public_channel", "500");
      yield* h.enrollment.complete({
        ...input,
        outcome: { kind: "accepted", code: "new-member" },
      });
      const newer = snapshot(h).repair;

      if (newer.kind !== "scheduled")
        return yield* Effect.die("Missing newer repair");
      expect(newer.id).not.toBe(old.id);
      expect(newer.attempts).toBe(0);
      yield* Deferred.succeed(h.control.listGate, undefined);
      yield* Fiber.join(repair);
      expect(snapshot(h).repair).toEqual(newer);
      expect(h.nativeAlarmAt()).toBe(newer.due);
      expect(snapshot(h).subscriptions["500"]).toBeUndefined();

      h.control.failCreate = true;
      h.time(newer.due);
      yield* h.alarm();
      const retried = snapshot(h).repair;
      expect(retried).toMatchObject({
        kind: "scheduled",
        id: newer.id,
        attempts: 1,
      });

      if (retried.kind !== "scheduled")
        return yield* Effect.die("Missing retry");
      h.control.failCreate = false;
      h.time(retried.due);
      yield* h.alarm();
      expect(snapshot(h).repair).toEqual({ kind: "idle" });
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "new_public_channel",
      });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "operator setup and alarm use one lease while retaining newly enrolled membership and proofs",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.usersGate = yield* Deferred.make<void>();
      const users = h.control.usersTokens.length;

      const setup = yield* h.account
        .setup("operator-digest")
        .pipe(Effect.forkChild);

      for (let i = 0; i < 100 && h.control.usersTokens.length === users; i++)
        yield* Effect.yieldNow;
      expect(h.control.usersTokens.length).toBe(users + 1);
      const lease = snapshot(h).setupLease;
      expect(lease).not.toBeNull();
      h.time(initial + 1);
      const creates = h.control.creates;
      yield* h.alarm();
      expect(h.control.creates).toBe(creates);
      expect(snapshot(h).setupLease).toEqual(lease);
      expect(h.nativeAlarmAt()).toBe((lease?.until ?? 0) + 1);
      yield* Deferred.succeed(h.control.usersGate, undefined);
      expect((yield* Fiber.join(setup)).status.channels.length).toBe(3);
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      const proof = snapshot(h).subscriptions["400"];
      h.time((lease?.until ?? 0) + 1);
      yield* h.alarm();
      expect(snapshot(h).subscriptions["400"]).toEqual(proof);
      expect(h.control.creates).toBe(creates + 1);
      expect(snapshot(h).repair).toEqual({ kind: "idle" });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "reconciliation preserves other callback and sender subscriptions while replacing only managed unknown receipts",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      const other = h.control.remote[0];

      if (!other) return yield* Effect.die("Missing remote fixture");
      h.control.remote.push({
        ...other,
        id: "other-application-callback",
        transport: {
          method: "webhook",
          callback: "https://other.invalid/webhooks/twitch",
        },
      });
      h.control.remote.push({
        ...other,
        id: "other-sender",
        condition: { ...other.condition, user_id: "other-sender" },
      });
      h.time(initial + 1);
      yield* h.alarm();
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(
        h.control.remote.some(
          (record) => record.id === "other-application-callback",
        ),
      ).toBeTrue();
      expect(
        h.control.remote.some((record) => record.id === "other-sender"),
      ).toBeTrue();
      expect(h.control.removes).toBe(0);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "public revocation isolates sender, other members and pending enrollment, then reauthorizes without operator OAuth",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const first = yield* enroll(h);
      const second = yield* enrollmentInput();
      yield* h.enrollment.begin(second);
      publicGrant(h, "public_second", "500");
      yield* h.enrollment.complete({
        ...second,
        outcome: { kind: "accepted", code: "second" },
      });
      h.time(initial + 1);
      yield* h.alarm();
      const pending = yield* enrollmentInput();
      yield* h.enrollment.begin(pending);
      const preRevocation = yield* enrollmentInput();
      yield* h.enrollment.begin(preRevocation);
      const before = snapshot(h);
      const record = before.subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public receipt");
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      expect(snapshot(h).authGeneration).toBe(before.authGeneration);
      expect(snapshot(h).grants["100"]).toEqual(before.grants["100"]);
      expect(snapshot(h).grants["500"]).toEqual(before.grants["500"]);
      expect(yield* h.enrollment.status(first.session)).toEqual({
        kind: "failed",
        reason: "authorization-required",
      });
      expect(yield* h.enrollment.status(second.session)).toEqual({
        kind: "ready",
        login: "public_second",
      });
      expect(
        (yield* h.account.dispatch(h.send("revoked-isolated", "400"))).kind,
      ).toBe("rejected");
      expect(
        (yield* h.account.dispatch(h.send("unaffected-member", "500"))).kind,
      ).toBe("sent");
      publicGrant(h);
      expect(
        (yield* h.enrollment
          .complete({
            ...preRevocation,
            outcome: { kind: "accepted", code: "pre-revocation" },
          })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      expect(snapshot(h).grants["400"]).toBeUndefined();
      publicGrant(h, "public_third", "600");
      yield* h.enrollment.complete({
        ...pending,
        outcome: { kind: "accepted", code: "pending" },
      });
      const reinstalled = yield* enroll(h);
      h.time(h.now() + 1);
      yield* h.alarm();
      expect(yield* h.enrollment.status(reinstalled.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(yield* h.enrollment.status(pending.session)).toEqual({
        kind: "ready",
        login: "public_third",
      });
      expect(h.control.sends).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "public revocation fences held reconciliation and an affected exchange while an unrelated in-flight exchange survives",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm();
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public receipt");
      const affected = yield* enrollmentInput();
      yield* h.enrollment.begin(affected);
      publicGrant(h);
      h.control.usersGate = yield* Deferred.make<void>();
      const users = h.control.usersTokens.length;

      const stale = yield* h.enrollment
        .complete({ ...affected, outcome: { kind: "accepted", code: "stale" } })
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.usersTokens.length === users; i++)
        yield* Effect.yieldNow;
      const unrelated = yield* enrollmentInput();
      yield* h.enrollment.begin(unrelated);
      publicGrant(h, "unrelated_public", "500");

      const valid = yield* h.enrollment
        .complete({
          ...unrelated,
          outcome: { kind: "accepted", code: "valid" },
        })
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.usersTokens.length < users + 2; i++)
        yield* Effect.yieldNow;
      h.control.listGate = yield* Deferred.make<void>();
      const usersGate = h.control.usersGate;
      h.control.usersGate = null;
      const lists = h.control.lists;

      const setup = yield* h.account
        .setup("operator-digest")
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.lists === lists; i++)
        yield* Effect.yieldNow;
      expect(h.control.lists).toBe(lists + 1);
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      yield* Deferred.succeed(h.control.listGate, undefined);
      const setupResult = yield* Fiber.join(setup);
      expect(Result.isFailure(setupResult) && setupResult.failure.code).toBe(
        "stale",
      );
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(snapshot(h).subscriptions["400"]?.status).toBe(
        "authorization_revoked",
      );
      yield* Deferred.succeed(usersGate, undefined);
      const staleResult = yield* Fiber.join(stale);
      expect(Result.isFailure(staleResult) && staleResult.failure.code).toBe(
        "state",
      );
      expect(Result.isSuccess(yield* Fiber.join(valid))).toBeTrue();
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(snapshot(h).grants["500"]).toEqual(["channel:bot"]);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "enrollment permits three individually valid slow calls and rejects completion beyond its total budget",
  Effect.gen(function* () {
    for (const elapsed of [11_700, 14_001]) {
      const h = yield* harness(production);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        const input = yield* enrollmentInput();
        yield* h.enrollment.begin(input);
        publicGrant(h);
        h.delayNextReadBy(9_000);
        h.control.exchangeElapsedMs = 3_900;
        h.control.grantValidationElapsedMs = 3_900;
        h.control.usersElapsedMs = elapsed - 7_800;

        const result = yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "slow" } })
          .pipe(Effect.result);

        if (elapsed === 11_700) {
          expect(Result.isSuccess(result)).toBeTrue();
          expect(snapshot(h).grants["400"]).toEqual(["channel:bot"]);
        } else {
          expect(Result.isFailure(result)).toBeTrue();
          expect(snapshot(h).publicMembers).toEqual([]);
          expect(snapshot(h).grants["400"]).toBeUndefined();
          expect(
            (yield* h.enrollment
              .complete({
                ...input,
                outcome: { kind: "accepted", code: "late" },
              })
              .pipe(Effect.flip)).code,
          ).toBe("state");
        }
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }
  }),
);

test(
  "setup reports capacity for expanded or replaced configuration without dropping stored membership",
  Effect.gen(function* () {
    for (const channelLogins of [
      [...production.channelLogins, "expanded"],
      ["replacement_a", "replacement_b", "replacement_c"],
    ]) {
      const h = yield* harness(production);
      yield* Effect.gen(function* () {
        yield* h.authorize();

        for (let i = 0; i < 30; i++) {
          const input = yield* enrollmentInput();
          yield* h.enrollment.begin(input);
          publicGrant(h, `public_${i}`, String(800 + i));
          yield* h.enrollment.complete({
            ...input,
            outcome: { kind: "accepted", code: "capacity" },
          });
        }

        const before = snapshot(h);
        expect(desiredChannels(before, production.kind).length).toBe(32);

        const changed = yield* h.construct("revision-one", "fixture-binding", {
          ...production,
          channelLogins,
        });

        const result = yield* changed.service
          .setup("operator-digest")
          .pipe(Effect.flip);

        expect(result.code).toBe("capacity");
        expect(snapshot(h).channels).toEqual(before.channels);
        expect(snapshot(h).publicMembers).toEqual(before.publicMembers);
        expect(snapshot(h).grants).toEqual(before.grants);
        expect(snapshot(h).setupLease).toBeNull();
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }
  }),
);

test(
  "a public revocation before a delayed create receipt prevents late proof persistence",
  Effect.gen(function* () {
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.createGate = yield* Deferred.make<void>();
      const creates = h.control.creates;
      h.time(initial + 1);
      const repair = yield* h.alarm().pipe(Effect.forkChild);

      for (let i = 0; i < 100 && h.control.creates === creates; i++)
        yield* Effect.yieldNow;
      expect(h.control.creates).toBe(creates + 1);

      const remote = h.control.remote.find(
        (record) => record.condition.broadcaster_user_id === "400",
      );

      if (!remote) return yield* Effect.die("Missing delayed remote create");
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
      yield* h.account.observeSubscription({
        id: remote.id,
        broadcasterId: BroadcasterId.make("400"),
        senderId: "100",
        callback: "https://fixture.invalid/webhooks/twitch",
        binding: "fixture-binding",
        status: "authorization_revoked",
      });
      yield* Deferred.succeed(h.control.createGate, undefined);
      yield* Fiber.join(repair);
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(snapshot(h).revoked[remote.id]?.reason).toBe(
        "authorization-revoked",
      );
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "authorization-required",
      });
      expect(
        (yield* h.account.dispatch(h.send("late-public-create", "400"))).kind,
      ).toBe("rejected");
      expect(
        (yield* h.account.dispatch(h.send("unaffected-configured"))).kind,
      ).toBe("sent");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "the total enrollment deadline cancels a held exchange and replay cannot commit later",
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const h = yield* harness(production);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enrollmentInput();
      yield* h.enrollment.begin(input);
      publicGrant(h);
      h.control.exchangeGate = yield* Deferred.make<void>();
      const exchanges = h.control.exchanges;

      const completion = yield* h.enrollment
        .complete({ ...input, outcome: { kind: "accepted", code: "held" } })
        .pipe(Effect.result, Effect.forkChild);

      for (let i = 0; i < 100 && h.control.exchanges === exchanges; i++)
        yield* Effect.yieldNow;
      expect(h.control.exchanges).toBe(exchanges + 1);
      h.time(initial + policy.enrollmentLeaseMs);
      yield* TestClock.adjust(policy.enrollmentLeaseMs).pipe(
        Effect.provideService(Clock.Clock, clock),
      );
      const result = yield* Fiber.join(completion);
      expect(Result.isFailure(result) && result.failure.code).toBe("state");
      yield* Deferred.succeed(h.control.exchangeGate, undefined);
      expect(snapshot(h).publicMembers).toEqual([]);
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "authorization-failed",
      });
      expect(
        (yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "replay" } })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      expect(h.control.exchanges).toBe(exchanges + 1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }).pipe(Effect.provide(TestClock.layer())),
);
