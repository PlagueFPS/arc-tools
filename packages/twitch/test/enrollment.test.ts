/* oxlint-disable effecttsgo/crypto-random-uuid -- Native fixture callbacks allocate secure operation IDs synchronously. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { expect } from "bun:test";

import {
  BroadcasterId,
  EnrollmentSession,
  type EnrollmentBegin,
} from "@arctools/twitch/server";
import {
  AccountState,
  ChannelRecord,
  desiredChannels,
  policy,
  SharedAccount,
} from "@arctools/twitch/testing";
import { digest } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Result,
  Schema,
  Array as Arr,
  Option,
} from "effect";
import { TestClock } from "effect/testing";

import { fixtureConfig, harness, initial } from "./account-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const bot = {
  ...fixtureConfig,
  senderKind: "bot",
  stage: "local-enrollment",
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
  Schema.decodeSync(AccountState)(h.snapshot());

const recovery = (
  h: Effect.Success<ReturnType<typeof harness>>,
  id = "400",
) => {
  const life = snapshot(h).lifecycle[id];

  if (life?.kind !== "installed" || !life.recovery)
    throw new Error("Missing channel recovery");

  return life.recovery;
};

const restoreLegacyCleanupRecords = (
  h: Effect.Success<ReturnType<typeof harness>>,
) => {
  const sessions = Arr.map(snapshot(h).enrollments, (entry) =>
    entry.phase.kind === "member"
      ? { ...entry, expiresAt: initial + policy.enrollmentSessionMs }
      : entry,
  );

  const record = Schema.decodeUnknownSync(ChannelRecord)(
    h.memory.values.get("account:channel:v1/400"),
  );

  h.memory.values.set("account:channel:v1/400", {
    ...record,
    public: Arr.map(record.public, (entry) => {
      const { cleanupAfter: _cleanupAfter, ...member } = entry.member;

      return { ...entry, member };
    }),
  });

  const { nextCleanupAt: _nextCleanupAt, ...shared } = Schema.decodeUnknownSync(
    SharedAccount,
  )(h.memory.values.get("account:shared:v1"));

  h.memory.values.set("account:shared:v1", shared);
  h.memory.values.set("account:enrollments:v1", sessions);
};

test(
  "a local dedicated bot cannot begin enrollment before sender authorization",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    const input = yield* enrollmentInput();
    expect((yield* h.enrollment.begin(input).pipe(Effect.flip)).code).toBe(
      "configuration",
    );
    expect(snapshot(h).publicMembers).toEqual([]);
    expect(snapshot(h).enrollments).toEqual([]);
    expect(h.control.exchanges).toBe(0);
  }),
);

for (const senderKind of ["personal", "synthetic"] as const) {
  test(
    `bot public membership stays dormant after a ${senderKind} transition and can be reauthorized in bot`,
    Effect.gen(function* () {
      const source = yield* harness(bot);
      yield* Effect.gen(function* () {
        yield* source.authorize();
        yield* enroll(source);
        source.time(initial + 1);
        yield* source.alarm;
      }).pipe(Effect.provideService(Clock.Clock, source.clock));

      const h = yield* harness({
        ...fixtureConfig,
        senderKind,
        channelLogins: [fixtureConfig.senderLogin],
      });

      h.restore(snapshot(source));
      h.control.remote = structuredClone(source.control.remote);
      h.control.creates = source.control.creates;
      yield* Effect.gen(function* () {
        const restored = yield* h.construct(`${senderKind}-revision`);
        yield* h.authorize(restored.service);
        expect(
          Arr.map((yield* restored.service.status).channels, (c) => c.login),
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
        yield* restored.credentialAlarm;
        expect(h.control.creates).toBe(creates);
        expect(h.control.sends).toBe(0);
      }).pipe(Effect.provideService(Clock.Clock, h.clock));

      const returned = yield* harness(bot);
      returned.restore(snapshot(h));
      returned.control.creates = h.control.creates;
      yield* Effect.gen(function* () {
        const restored = yield* returned.construct("returned-bot");
        yield* returned.authorize(restored.service);
        expect(
          Arr.map((yield* restored.service.status).channels, (c) => c.login),
        ).toEqual(["public_channel", ...bot.channelLogins]);
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
        yield* restored.credentialAlarm;
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

for (const stage of ["local-enrollment", "staging", "prod"]) {
  test(
    `${stage} bot membership preserves sender, grants and limits through alarm, dispatch and repeated setup`,
    Effect.gen(function* () {
      const h = yield* harness({
        ...bot,
        stage,
        twitchClientId: `controlled-${stage}-application`,
      });

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
        expect(saved.repair.kind).toBe("idle");
        expect(saved.nextRecoveryAt).toBe(initial + 1);
        expect(h.nativeAlarmAt()).toBe(initial + 1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            h.snapshot(),
          ).pipe(Effect.orDie),
        ).not.toContain("canary-user-token");
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            h.snapshot(),
          ).pipe(Effect.orDie),
        ).not.toContain(input.state);
        expect(yield* h.enrollment.status(input.session)).toEqual({
          kind: "recovering",
          login: "public_channel",
        });
        h.time(initial + 1);
        h.consumeAlarm();
        yield* h.alarm;
        expect(yield* h.enrollment.status(input.session)).toEqual({
          kind: "ready",
          login: "public_channel",
        });
        expect(
          (yield* h.account.dispatch(h.send("public-send", "400"))).kind,
        ).toBe("sent");
        expect(
          Arr.map(
            (yield* h.account.setup("operator-digest")).status.channels,
            (channel) => String(channel.id),
          ),
        ).toEqual(["400", "200", "300"]);
        expect(snapshot(h).publicMembers).toEqual([
          {
            id: BroadcasterId.make("400"),
            login: "public_channel",
            revocationGeneration: 0,
            cleanupAfter: null,
          },
        ]);
        const exchanges = h.control.exchanges;
        expect(
          (yield* h.enrollment
            .complete({
              ...input,
              outcome: { kind: "accepted", code: "replay" },
            })
            .pipe(Effect.flip)).code,
        ).toBe("state");
        expect(h.control.exchanges).toBe(exchanges);
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );
}

test(
  "wrong session and state cannot consume valid authorization or denial; expiry and denial exchange nothing",
  Effect.gen(function* () {
    const h = yield* harness(bot);
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
      const h = yield* harness(bot);
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
    for (const fence of ["lease", "revision", "expiry"]) {
      const h = yield* harness(bot);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        const input = yield* enrollmentInput();
        yield* h.enrollment.begin(input);
        publicGrant(h);
        h.control.exchangeGate = yield* Deferred.make<void>();
        h.control.exchangeStarted = yield* Deferred.make<void>();
        const exchanges = h.control.exchanges;

        const complete = yield* h.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "secret" } })
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(h.control.exchangeStarted);
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
      ...bot,
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
      h.control.usersStarted = yield* Deferred.make<void>();
      publicGrant(h, "public_a", "800");
      const users = h.control.usersTokens.length;

      const a = yield* h.enrollment
        .complete({ ...replacement, outcome: { kind: "accepted", code: "a" } })
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      publicGrant(h, "public_b", "900");
      h.control.usersStarted = yield* Deferred.make<void>();

      const b = yield* h.enrollment
        .complete({ ...second, outcome: { kind: "accepted", code: "b" } })
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      expect(h.control.usersTokens.length).toBe(users + 2);
      yield* Deferred.succeed(h.control.usersGate, undefined);
      const outcomes = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(Arr.filter(outcomes, Result.isSuccess).length).toBe(1);
      expect(
        Arr.flatMap(outcomes, (result) =>
          Result.isFailure(result) ? [result.failure.code] : [],
        ),
      ).toEqual(["capacity"]);
      expect(desiredChannels(snapshot(h), bot.senderKind).length).toBe(32);
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
      expect(desiredChannels(snapshot(h), bot.senderKind).length).toBe(32);
      h.time(initial + policy.oauthMs);
      yield* h.enrollment.begin(yield* enrollmentInput());
      expect(
        Arr.filter(
          snapshot(h).enrollments,
          (entry) => !!(entry.phase.kind === "pending"),
        ).length,
      ).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "current keyed membership survives reconstruction and revision while previous sessions require reauthorization",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();

      const input = yield* enroll(h);
      const installed = snapshot(h);
      h.restoreRaw(yield* Schema.encodeEffect(AccountState)(installed));
      const reconstructed = yield* h.construct();
      expect((yield* reconstructed.service.status).setup).toBe("pending");
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
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.time(initial + 1);
      h.control.failCreate = true;
      yield* h.alarm;

      const unknown = Option.getOrUndefined(
        Arr.findFirst(
          h.control.remote,
          (sub) => !!(sub.condition.broadcaster_user_id === "400"),
        ),
      )?.id;

      expect(unknown).toBeDefined();
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
      const recovered = yield* h.construct();
      h.control.failCreate = false;
      h.control.subscriptionStatus = "webhook_callback_verification_pending";
      h.time(recovery(h).due);
      h.consumeAlarm();
      yield* recovered.credentialAlarm;
      expect(
        Arr.some(h.control.remote, (sub) => !!(sub.id === unknown)),
      ).toBeFalse();
      const record = snapshot(h).subscriptions["400"];

      if (!record)
        return yield* Effect.die("Missing repaired subscription receipt");
      expect(yield* recovered.enrollment.status(input.session)).toEqual({
        kind: "recovering",
        login: "public_channel",
      });
      yield* recovered.service.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "webhook_callback_verification_pending",
      });
      expect(yield* recovered.enrollment.status(input.session)).toEqual({
        kind: "recovering",
        login: "public_channel",
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
      h.time(h.now() + 60_000);
      yield* recovered.credentialAlarm;
      expect(snapshot(h).repair).toEqual({ kind: "idle" });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "recovery persists beyond eight failed attempts and reconstruction without losing grants",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.failCreate = true;
      const life = snapshot(h).lifecycle["400"];

      for (let attempt = 0; attempt < 8; attempt++) {
        const due = recovery(h).due;
        h.time(due);
        h.consumeAlarm();
        const restored = yield* h.construct();
        yield* restored.credentialAlarm;
        const next = recovery(h);
        const base = [60_000, 300_000][attempt] ?? 900_000;
        expect(next.due - due).toBeGreaterThanOrEqual(base * 0.9);
        expect(next.due - due).toBeLessThanOrEqual(base * 1.1);
        expect(snapshot(h).grants["400"]).toEqual(["channel:bot"]);
      }

      expect(snapshot(h).lifecycle["400"]).toMatchObject({
        kind: "installed",
        id: life?.kind === "installed" ? life.id : "missing",
      });
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "recovering",
        login: "public_channel",
      });
      h.control.failCreate = false;
      h.time(recovery(h).due);
      yield* h.alarm;
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "revocation stops readiness and a new grant reinstalls without replacing sender; personal environments deny mutation",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public subscription");
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "left",
        login: "public_channel",
      });
      expect(
        (yield* h.account.dispatch(h.send("revoked-public", "400"))).kind,
      ).toBe("rejected");
      yield* h.authorize();
      const reinstalled = yield* enroll(h);
      h.time(h.now() + 1);
      yield* h.alarm;
      expect(yield* h.enrollment.status(reinstalled.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(snapshot(h).sender?.id).toBe("100");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));

    for (const senderKind of ["personal", "synthetic"] as const) {
      const restricted = yield* harness({
        ...fixtureConfig,
        senderKind,
        stage: senderKind === "personal" ? "staging" : fixtureConfig.stage,
        senderLogin: "personal",
        channelLogins: ["personal"],
      });

      const input = yield* enrollmentInput();
      const before = restricted.snapshot();
      expect(
        (yield* restricted.enrollment.begin(input).pipe(Effect.flip)).code,
      ).toBe("configuration");
      expect(
        (yield* restricted.enrollment
          .complete({ ...input, outcome: { kind: "accepted", code: "secret" } })
          .pipe(Effect.flip)).code,
      ).toBe("configuration");
      expect(restricted.snapshot()).toEqual(before);
      expect(restricted.control.exchanges).toBe(0);
      expect(yield* restricted.enrollment.status(input.session)).toEqual({
        kind: "failed",
        reason: "unavailable",
      });
    }
  }),
);

for (const status of ["authorization_revoked", "user_removed"] as const)
  test(
    `${status} public installation storage expires without traffic while other memberships survive`,
    Effect.gen(function* () {
      const h = yield* harness(bot);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        const revoked = yield* enroll(h);
        const survivor = yield* enrollmentInput();
        yield* h.enrollment.begin(survivor);
        publicGrant(h, "public_second", "500");
        yield* h.enrollment.complete({
          ...survivor,
          outcome: { kind: "accepted", code: "second" },
        });
        const pending = yield* enrollmentInput();
        yield* h.enrollment.begin(pending);
        h.time(initial + 1);
        yield* h.alarm;
        const record = snapshot(h).subscriptions["400"];

        if (!record) return yield* Effect.die("Missing public subscription");
        yield* h.account.observeSubscription({
          ...record,
          broadcasterId: BroadcasterId.make("400"),
          status,
        });
        expect(yield* h.enrollment.status(revoked.session)).toEqual({
          kind: "left",
          login: "public_channel",
        });

        const cleanupAt =
          initial + 1 + Math.max(policy.oauthMs, policy.retentionMs);

        expect(snapshot(h).nextCleanupAt).toBeLessThanOrEqual(cleanupAt);
        h.time(cleanupAt - 1);
        h.consumeAlarm();
        yield* h.alarm;
        expect(h.memory.values.has("account:channel:v1/400")).toBeTrue();
        h.time(cleanupAt);
        h.consumeAlarm();
        const restored = yield* h.construct();
        yield* restored.credentialAlarm;
        expect(
          Arr.map(snapshot(h).publicMembers, (member) => member.id),
        ).toEqual([BroadcasterId.make("500")]);
        expect(snapshot(h).subscriptions["400"]).toBeUndefined();
        expect(
          Arr.map(snapshot(h).enrollments, (entry) => entry.session),
        ).toEqual([survivor.session, revoked.session]);
        expect(snapshot(h).grants["400"]).toBeUndefined();
        expect(snapshot(h).grants["100"]).toContain("user:bot");
        expect(snapshot(h).lifecycle["400"]?.kind).toBe("removed");
        expect(h.memory.values.has("account:channel:v1/500")).toBeTrue();
        expect(yield* restored.enrollment.status(survivor.session)).toEqual({
          kind: "ready",
          login: "public_second",
        });
        publicGrant(h);
        expect(
          (yield* h.enrollment
            .complete({
              ...pending,
              outcome: { kind: "accepted", code: "stale" },
            })
            .pipe(Effect.flip)).code,
        ).toBe("state");
        const reinstalled = yield* enroll(h);
        h.time(h.now() + 1);
        yield* h.alarm;
        expect(yield* h.enrollment.status(reinstalled.session)).toEqual({
          kind: "ready",
          login: "public_channel",
        });
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );

test(
  "an old revocation cannot delete reauthorization during timestamp skew or after deduplication expires",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const old = snapshot(h).subscriptions["400"];

      if (!old) return yield* Effect.die("Missing public subscription");

      const observation = {
        ...old,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      };

      yield* h.account.observeSubscription(observation);
      const renewed = yield* enroll(h);
      h.time(initial + 2);
      yield* h.alarm;
      const replacement = snapshot(h).subscriptions["400"]?.id;
      expect(replacement).not.toBe(old.id);
      h.time(initial + policy.retentionMs + 2);
      h.consumeAlarm();
      yield* h.alarm;
      expect(snapshot(h).revoked[old.id]?.until).toBeGreaterThan(h.now());
      yield* h.account.observeSubscription(observation);
      expect(snapshot(h).grants["400"]).toEqual(["channel:bot"]);
      h.time(initial + policy.revocationMs + 2);
      h.consumeAlarm();
      yield* h.alarm;
      expect(snapshot(h).revoked[old.id]).toBeUndefined();
      yield* h.account.observeSubscription(observation);
      h.time(h.now() + policy.retentionMs);
      h.consumeAlarm();
      yield* h.alarm;
      expect(snapshot(h).subscriptions["400"]?.id).toBe(replacement);
      expect(h.memory.values.has("account:channel:v1/400")).toBeTrue();
      expect(yield* h.enrollment.status(renewed.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "authorization loss discovered near retirement expiry retains a full replay window",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public subscription");
      yield* h.store.update((state) => {
        state.revoked[record.id] = {
          until: h.now() + 1,
          reason: "retired",
          deleteDue: null,
        };
      });
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      expect(snapshot(h).revoked[record.id]).toMatchObject({
        until: h.now() + policy.revocationMs,
        reason: "authorization-revoked",
        deleteDue: h.now() + 1,
      });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "list-confirmed user removal schedules public membership cleanup when its webhook was missed",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      h.control.remote = Arr.map(h.control.remote, (record) =>
        record.condition.broadcaster_user_id === "400"
          ? { ...record, status: "user_removed" }
          : record,
      );
      const creates = h.control.creates;
      yield* h.account.setup("operator-digest").pipe(Effect.result);
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(snapshot(h).publicMembers).toEqual([]);
      expect(snapshot(h).lifecycle["400"]?.kind).toBe("removed");
      expect(h.control.creates).toBe(creates);
      h.time(h.now() + Math.max(policy.oauthMs, policy.retentionMs));
      h.consumeAlarm();
      yield* h.alarm;
      expect(snapshot(h).lifecycle["400"]?.kind).toBe("removed");
      expect(snapshot(h).grants["100"]).toContain("user:bot");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "legacy revoked keyed membership schedules cleanup during reconstruction without new traffic",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const subscription = snapshot(h).subscriptions["400"];

      if (!subscription)
        return yield* Effect.die("Missing public subscription");
      yield* h.store.update((state) => {
        state.subscriptions["400"] = {
          ...subscription,
          status: "authorization_revoked",
        };
        delete state.grants["400"];
      });
      restoreLegacyCleanupRecords(h);
      h.time(initial + policy.retentionMs + 2);
      const restored = yield* h.construct();
      expect(h.nativeAlarmAt()).toBeLessThanOrEqual(h.now());
      yield* restored.credentialAlarm;
      const cleanupAfter = snapshot(h).publicMembers[0]?.cleanupAfter;
      expect(cleanupAfter).toBe(
        h.now() + Math.max(policy.oauthMs, policy.retentionMs),
      );
      h.time(h.now() + Math.max(policy.oauthMs, policy.retentionMs));
      h.consumeAlarm();
      yield* restored.credentialAlarm;
      expect(snapshot(h).publicMembers).toEqual([]);
      expect(snapshot(h).enrollments).toEqual([]);
      expect(snapshot(h).grants["100"]).toContain("user:bot");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

for (const authorized of [true, false])
  test(
    `legacy membership with authorized=${authorized} survives compatibility cleanup without revocation proof`,
    Effect.gen(function* () {
      const h = yield* harness(bot);
      yield* Effect.gen(function* () {
        yield* h.authorize();
        yield* enroll(h);
        h.time(initial + 1);
        yield* h.alarm;

        if (!authorized)
          yield* h.store.update((state) => {
            delete state.grants["400"];
          });

        restoreLegacyCleanupRecords(h);
        const restored = yield* h.construct();
        expect(h.nativeAlarmAt()).toBeLessThanOrEqual(h.now());
        yield* restored.credentialAlarm;
        expect(snapshot(h).publicMembers[0]?.cleanupAfter).toBeNull();
        h.time(initial + policy.enrollmentSessionMs + 1);
        h.consumeAlarm();
        yield* restored.credentialAlarm;
        expect(h.memory.values.has("account:channel:v1/400")).toBeTrue();
        expect(snapshot(h).publicMembers[0]?.cleanupAfter).toBeNull();
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );

test(
  "reauthorization before cleanup preserves the renewed installation after the old expiry",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public subscription");
      yield* h.account.observeSubscription({
        ...record,
        broadcasterId: BroadcasterId.make("400"),
        status: "authorization_revoked",
      });
      const renewed = yield* enroll(h);
      h.time(initial + 2);
      yield* h.alarm;
      h.time(initial + 1 + Math.max(policy.oauthMs, policy.retentionMs));
      h.consumeAlarm();
      yield* h.alarm;
      expect(yield* h.enrollment.status(renewed.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(h.memory.values.has("account:channel:v1/400")).toBeTrue();
      expect(snapshot(h).publicMembers[0]?.cleanupAfter).toBeNull();
      expect(snapshot(h).nextCleanupAt).toBeGreaterThan(h.now());
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "a held recovery cannot consume a newer channel's independent schedule",
  Effect.gen(function* () {
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.control.listGate = yield* Deferred.make<void>();
      h.control.listStarted = yield* Deferred.make<void>();
      h.time(initial + 1);
      const repair = yield* h.alarm.pipe(Effect.forkChild);
      yield* Deferred.await(h.control.listStarted);
      const input = yield* enrollmentInput();
      yield* h.enrollment.begin(input);
      publicGrant(h, "new_public_channel", "500");
      yield* h.enrollment.complete({
        ...input,
        outcome: { kind: "accepted", code: "new-member" },
      });
      const newer = recovery(h, "500");
      yield* Deferred.succeed(h.control.listGate, undefined);
      yield* Fiber.join(repair);
      expect(recovery(h, "500")).toEqual(newer);
      expect(snapshot(h).subscriptions["500"]).toBeUndefined();
      h.time(newer.due);
      yield* h.alarm;
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
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.usersGate = yield* Deferred.make<void>();
      h.control.usersStarted = yield* Deferred.make<void>();
      const users = h.control.usersTokens.length;

      const setup = yield* h.account
        .setup("operator-digest")
        .pipe(Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      expect(h.control.usersTokens.length).toBe(users + 1);
      const lease = snapshot(h).setupLease;
      expect(lease).not.toBeNull();
      h.time(initial + 1);
      const creates = h.control.creates;
      yield* h.alarm;
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
      yield* h.alarm;
      expect(snapshot(h).subscriptions["400"]).toEqual(proof);
      expect(h.control.creates).toBe(creates + 1);
      expect(snapshot(h).repair).toEqual({ kind: "idle" });
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "reconciliation preserves other callback and sender subscriptions while replacing only managed unknown receipts",
  Effect.gen(function* () {
    const h = yield* harness(bot);
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
      yield* h.alarm;
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "ready",
        login: "public_channel",
      });
      expect(
        Arr.some(
          h.control.remote,
          (record) => !!(record.id === "other-application-callback"),
        ),
      ).toBeTrue();
      expect(
        Arr.some(
          h.control.remote,
          (record) => !!(record.id === "other-sender"),
        ),
      ).toBeTrue();
      expect(h.control.removes).toBe(0);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "public revocation isolates sender, other members and pending enrollment, then reauthorizes without operator OAuth",
  Effect.gen(function* () {
    const h = yield* harness(bot);
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
      yield* h.alarm;
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
        kind: "left",
        login: "public_channel",
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
      yield* h.alarm;
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
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* enroll(h);
      h.time(initial + 1);
      yield* h.alarm;
      const record = snapshot(h).subscriptions["400"];

      if (!record) return yield* Effect.die("Missing public receipt");
      const affected = yield* enrollmentInput();
      yield* h.enrollment.begin(affected);
      publicGrant(h);
      h.control.usersGate = yield* Deferred.make<void>();
      h.control.usersStarted = yield* Deferred.make<void>();
      const users = h.control.usersTokens.length;

      const stale = yield* h.enrollment
        .complete({ ...affected, outcome: { kind: "accepted", code: "stale" } })
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      const unrelated = yield* enrollmentInput();
      yield* h.enrollment.begin(unrelated);
      publicGrant(h, "unrelated_public", "500");
      h.control.usersStarted = yield* Deferred.make<void>();

      const valid = yield* h.enrollment
        .complete({
          ...unrelated,
          outcome: { kind: "accepted", code: "valid" },
        })
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      expect(h.control.usersTokens.length).toBe(users + 2);
      h.control.listGate = yield* Deferred.make<void>();
      h.control.listStarted = yield* Deferred.make<void>();
      const usersGate = h.control.usersGate;
      h.control.usersGate = null;
      const lists = h.control.lists;

      const setup = yield* h.account
        .setup("operator-digest")
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.listStarted);
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
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
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
      const h = yield* harness(bot);
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
      [...bot.channelLogins, "expanded"],
      ["replacement_a", "replacement_b", "replacement_c"],
    ]) {
      const h = yield* harness(bot);
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
        expect(desiredChannels(before, bot.senderKind).length).toBe(32);

        const changed = yield* h.construct("revision-one", "fixture-binding", {
          ...bot,
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
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enroll(h);
      h.control.createGate = yield* Deferred.make<void>();
      h.control.createStarted = yield* Deferred.make<void>();
      const creates = h.control.creates;
      h.time(initial + 1);
      const repair = yield* h.alarm.pipe(Effect.forkChild);

      yield* Deferred.await(h.control.createStarted);
      expect(h.control.creates).toBe(creates + 1);

      const remote = Option.getOrUndefined(
        Arr.findFirst(
          h.control.remote,
          (record) => !!(record.condition.broadcaster_user_id === "400"),
        ),
      );

      if (!remote) return yield* Effect.die("Missing delayed remote create");
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();

      const revoking = yield* h.account
        .observeSubscription({
          id: remote.id,
          broadcasterId: BroadcasterId.make("400"),
          senderId: "100",
          callback: "https://fixture.invalid/webhooks/twitch",
          binding: "fixture-binding",
          status: "authorization_revoked",
        })
        .pipe(Effect.forkChild);

      yield* Deferred.succeed(h.control.createGate, undefined);
      yield* Fiber.join(repair);
      yield* Fiber.join(revoking);
      expect(snapshot(h).subscriptions["400"]).toBeUndefined();
      expect(snapshot(h).grants["400"]).toBeUndefined();
      expect(snapshot(h).revoked[remote.id]?.reason).toBe(
        "authorization-revoked",
      );
      expect(yield* h.enrollment.status(input.session)).toEqual({
        kind: "left",
        login: "public_channel",
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
    const h = yield* harness(bot);
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const input = yield* enrollmentInput();
      yield* h.enrollment.begin(input);
      publicGrant(h);
      h.control.exchangeGate = yield* Deferred.make<void>();
      h.control.exchangeStarted = yield* Deferred.make<void>();
      const exchanges = h.control.exchanges;

      const completion = yield* h.enrollment
        .complete({ ...input, outcome: { kind: "accepted", code: "held" } })
        .pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(h.control.exchangeStarted);
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
