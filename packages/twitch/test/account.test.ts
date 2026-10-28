import { expect } from "bun:test";

import type { AccountIdentity } from "@arctools/twitch/server";
import { Dispatch } from "@arctools/twitch/server";
import {
  senderScopes,
  AccountState,
  nextAlarm,
} from "@arctools/twitch/testing";
import type { SendResult } from "@arctools/twitch/testing";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Array as Arr,
  Option,
  String as Str,
} from "effect";

import { fixtureConfig, harness, initial } from "./account-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

test(
  "recovery schedules the next credential action when an existing session has an unexpired lease",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const persisted = yield* Schema.decodeEffect(AccountState)(h.snapshot());
      const until = initial + 10_000;
      h.restore({ ...persisted, tokenLease: { owner: "interrupted", until } });
      const recovered = yield* h.construct();
      const validations = h.control.validations;
      h.time(initial + 1);
      h.consumeAlarm();
      yield* recovered.credentialAlarm;
      expect(h.control.validations).toBe(validations);
      expect(h.alarmAt()).toBe(until);
      expect(h.nativeAlarmAt()).toBe(until);
      h.time(until);
      h.consumeAlarm();
      yield* recovered.credentialAlarm;
      expect(h.control.validations).toBe(validations + 1);
      expect(h.alarmAt()).toBeGreaterThan(until);
      expect(h.nativeAlarmAt()).toBe(nextAlarm(h.snapshot()));
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "a consumed alarm is rearmed when a cached credential leaves the intended timestamp unchanged",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const intended = h.alarmAt();
      h.consumeAlarm();
      yield* h.alarm;
      expect(h.alarmAt()).toBe(intended);
      expect(h.nativeAlarmAt()).toBe(nextAlarm(h.snapshot()));
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "a held validation cannot resurrect a session rejected by a newer send 401",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      h.control.appExpires = 7200;
      yield* h.authorize();
      h.control.sendGate = yield* Deferred.make<void>();
      h.control.sendStarted = yield* Deferred.make<void>();
      h.control.result = { kind: "unauthorized" };

      const send = yield* h.account
        .dispatch(h.send("overlapping-401"))
        .pipe(Effect.forkChild);

      yield* Deferred.await(h.control.sendStarted);
      expect(h.control.sends).toBe(1);
      yield* h.store.shared((state) => {
        state.sweepAt = initial + 7_200_000;
      });
      h.time(initial + 3_600_000);
      h.control.validationGate = yield* Deferred.make<void>();
      h.control.validationStarted = yield* Deferred.make<void>();
      const before = h.control.validations;
      const checking = yield* h.alarm.pipe(Effect.forkChild);

      yield* Deferred.await(h.control.validationStarted);
      expect(h.control.validations).toBe(before + 1);
      yield* Deferred.succeed(h.control.sendGate, undefined);
      yield* Fiber.join(send);
      expect((yield* h.account.status).credential).toBe("absent");
      yield* Deferred.succeed(h.control.validationGate, undefined);
      yield* Fiber.join(checking);
      expect((yield* h.account.status).credential).toBe("absent");
      h.control.validationGate = null;
      h.control.sendGate = null;
      h.control.result = { kind: "sent", messageId: "fresh-session" };
      expect(
        (yield* h.account.dispatch(h.send("after-overlapping-401"))).kind,
      ).toBe("sent");
      expect(h.control.mints).toBe(2);
      expect(h.control.sends).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "interrupted subscription bindings survive repeated rotations and reconstruction",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();

      for (const binding of ["binding-b", "binding-c"]) {
        h.control.binding = binding;
        h.control.failCreate = true;
        const rotated = yield* h.construct(binding, binding);
        expect((yield* h.authorize(rotated.service)).status.setup).toBe(
          "pending",
        );
        expect(
          Arr.some(
            h.control.remote,
            (sub) => !!(h.control.remoteBindings[sub.id] === binding),
          ),
        ).toBeTrue();
      }

      h.control.binding = "binding-d";
      h.control.failCreate = false;
      const final = yield* h.construct("binding-d", "binding-d");
      expect((yield* h.authorize(final.service)).status.setup).toBe("ready");
      expect(
        Arr.map(h.control.remote, (sub) => h.control.remoteBindings[sub.id]),
      ).toEqual(["binding-d", "binding-d"]);
      const creates = h.control.creates;
      const reconstructed = yield* h.construct("binding-d", "binding-d");
      expect(
        (yield* reconstructed.service.setup("operator-digest")).status.setup,
      ).toBe("ready");
      expect(h.control.creates).toBe(creates);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "interrupted creation without a receipt replaces the unknown remote ID on repair",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      h.control.failCreate = true;
      expect((yield* h.authorize()).status.setup).toBe("pending");
      const existing = h.control.remote[0]?.id;
      expect(existing).toBeDefined();
      h.control.failCreate = false;
      const recovered = yield* h.construct();
      expect(
        (yield* recovered.service.setup("operator-digest")).status.setup,
      ).toBe("ready");
      expect(
        Arr.some(h.control.remote, (sub) => !!(sub.id === existing)),
      ).toBeFalse();
      expect(h.control.creates).toBe(4);
      expect(h.control.removes).toBe(2);
      expect(
        Arr.map(h.control.remote, (sub) => h.control.remoteBindings[sub.id]),
      ).toEqual(["fixture-binding", "fixture-binding"]);
      const persisted = yield* h.construct();
      yield* persisted.service.setup("operator-digest");
      expect(h.control.creates).toBe(4);
      expect(h.control.removes).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "setup users 401 invalidates the app session and the next setup mints again",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      h.control.failUsers = true;
      expect(
        (yield* h.account.setup("operator-digest").pipe(Effect.flip)).code,
      ).toBe("client");
      expect((yield* h.account.status).credential).toBe("absent");
      h.control.failUsers = false;
      expect(
        (yield* h.account.setup("operator-digest")).authorizations.length,
      ).toBe(3);
      expect(h.control.mints).toBe(2);
      expect(h.control.usersTokens.length).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "a late setup users 401 cannot invalidate a replacement session, and provider ambiguity preserves it",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      h.control.usersFailure = "client";
      h.control.usersGate = yield* Deferred.make<void>();
      h.control.usersStarted = yield* Deferred.make<void>();
      const users = h.control.usersTokens.length;

      const setup = yield* h.account
        .setup("operator-digest")
        .pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(h.control.usersStarted);
      expect(h.control.usersTokens.length).toBe(users + 1);
      h.control.result = { kind: "unauthorized" };
      expect((yield* h.account.dispatch(h.send("setup-old-token"))).kind).toBe(
        "retryable",
      );
      h.time(initial + 1000);
      h.control.result = { kind: "sent", messageId: "replacement" };
      expect((yield* h.account.dispatch(h.send("setup-new-token"))).kind).toBe(
        "sent",
      );
      expect(h.control.mints).toBe(2);
      yield* Deferred.succeed(h.control.usersGate, undefined);
      expect((yield* Fiber.join(setup)).code).toBe("client");
      expect((yield* h.account.status).credential).toBe("valid");
      h.control.usersGate = null;
      h.control.usersFailure = "provider";
      expect(
        (yield* h.account.setup("operator-digest").pipe(Effect.flip)).code,
      ).toBe("provider");
      expect((yield* h.account.status).credential).toBe("valid");
      expect(h.control.mints).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "validation completed before a late send 401 preserves the rejected token's generation",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      h.control.appExpires = 7200;
      yield* h.authorize();
      h.control.sendGate = yield* Deferred.make<void>();
      h.control.sendStarted = yield* Deferred.make<void>();
      h.control.result = { kind: "unauthorized" };

      const send = yield* h.account
        .dispatch(h.send("late-send-401"))
        .pipe(Effect.forkChild);

      yield* Deferred.await(h.control.sendStarted);
      expect(h.control.sends).toBe(1);
      yield* h.store.shared((state) => {
        state.sweepAt = initial + 7_200_000;
      });
      h.time(initial + 3_600_000);
      yield* h.alarm;
      yield* Deferred.succeed(h.control.sendGate, undefined);
      yield* Fiber.join(send);
      expect((yield* h.account.status).credential).toBe("absent");
      h.control.sendGate = null;
      h.control.result = { kind: "sent", messageId: "minted" };
      expect(
        (yield* h.account.dispatch(h.send("after-late-send-401"))).kind,
      ).toBe("sent");
      expect(h.control.mints).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "32 channels and a distinct sender allocate all links atomically across repeats and expiry",
  Effect.gen(function* () {
    const identity = {
      ...fixtureConfig,
      channelLogins: Array.from(
        { length: 32 },
        (_, i) => `fixture_channel_${i}`,
      ),
    } satisfies AccountIdentity;

    const h = yield* harness(identity);
    yield* Effect.gen(function* () {
      for (let repeat = 0; repeat < 4; repeat++) {
        const setup = yield* h.account.setup("operator-digest");
        expect(setup.authorizations.length).toBe(33);
        expect(
          new Set(Arr.map(setup.authorizations, (auth) => auth.login)).size,
        ).toBe(33);

        const persisted = yield* Schema.decodeEffect(AccountState)(
          h.snapshot(),
        );

        expect(persisted.oauth.length).toBe(33);
        expect(
          Arr.every(
            persisted.oauth,
            (state) =>
              !!Arr.some(
                setup.authorizations,
                (auth) => !!(auth.login === state.login),
              ),
          ),
        ).toBeTrue();
      }

      h.time(initial + 600_000);
      const recovered = yield* h.construct();
      expect(
        (yield* recovered.service.setup("operator-digest")).authorizations
          .length,
      ).toBe(33);
      expect(
        (yield* Schema.decodeEffect(AccountState)(h.snapshot())).oauth.length,
      ).toBe(33);
      expect((yield* h.authorize(recovered.service)).status.setup).toBe(
        "ready",
      );
      expect(h.control.remote.length).toBe(32);
      expect(
        (yield* Schema.decodeEffect(AccountState)(h.snapshot())).oauth.length,
      ).toBe(0);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "capacity recovery discards obsolete granted states before allocating newly revoked roles",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const initialSetup = yield* h.account.setup("operator-digest");

      for (const auth of initialSetup.authorizations.slice(0, 2)) {
        const params = new URL(auth.url).searchParams;
        h.control.grantUser = auth.login === "fixture_sender" ? "100" : "200";
        h.control.grantLogin = auth.login;
        h.control.grantScopes =
          Option.getOrUndefined(
            Option.map(
              Option.fromNullishOr(params.get("scope")),
              (effectNativeValue0) => Str.split(effectNativeValue0, " "),
            ),
          ) ?? [];
        yield* h.account.completeOAuth({
          state: params.get("state") ?? "",
          code: "code",
          operator: "operator-digest",
        });
      }

      let latest = "";

      for (let i = 0; i < 32; i++) {
        const setup = yield* h.account.setup("operator-digest");
        expect(setup.authorizations.length).toBe(1);
        latest =
          new URL(setup.authorizations[0]?.url ?? "").searchParams.get(
            "state",
          ) ?? "";
      }

      h.control.grantUser = "300";
      h.control.grantLogin = "fixture_other";
      h.control.grantScopes = ["channel:bot"];
      yield* h.account.completeOAuth({
        state: latest,
        code: "code",
        operator: "operator-digest",
      });
      expect((yield* h.account.setup("operator-digest")).status.setup).toBe(
        "ready",
      );

      const subscription = Option.getOrUndefined(
        Arr.findFirst(
          h.control.remote,
          (sub) => !!(sub.condition.broadcaster_user_id === "200"),
        ),
      );

      if (!subscription)
        return yield* Effect.die("Missing revoked subscription");
      yield* h.account.observeSubscription({
        id: subscription.id,
        broadcasterId: Dispatch.fields.broadcasterId.make("200"),
        senderId: "100",
        binding: "fixture-binding",
        callback: "https://fixture.invalid/webhooks/twitch",
        status: "authorization_revoked",
      });
      expect(
        Arr.map(
          (yield* h.account.setup("operator-digest")).authorizations,
          (auth) => auth.login,
        ),
      ).toEqual(["fixture_channel"]);
      expect(
        (yield* Schema.decodeEffect(AccountState)(h.snapshot())).oauth.length,
      ).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

for (const [name, change, code] of [
  [
    "identity",
    (c: { grantUser: string }) => {
      c.grantUser = "999";
    },
    "identity",
  ],
  [
    "client",
    (c: { grantClient: string }) => {
      c.grantClient = "wrong-client";
    },
    "client",
  ],
  [
    "scopes",
    (c: { grantScopes: string[] }) => {
      c.grantScopes = [];
    },
    "scopes",
  ],
] as const) {
  test(
    `OAuth rejects returned ${name} mismatch and consumes the state`,
    Effect.gen(function* () {
      const h = yield* harness();
      const setup = yield* h.account.setup("operator-digest");

      const input = {
        state:
          new URL(setup.authorizations[0]?.url ?? "").searchParams.get(
            "state",
          ) ?? "",
        code: "code",
        operator: "operator-digest",
      };

      change(h.control);
      const result = yield* h.account.completeOAuth(input).pipe(Effect.flip);
      expect(result.code).toBe(code);
      expect(
        (yield* h.account.completeOAuth(input).pipe(Effect.flip)).code,
      ).toBe("state");
      expect((yield* h.account.status).sender?.authorized).toBeFalse();
    }),
  );
}

test(
  "OAuth rejects expiry equality, operator mismatch and configuration replacement",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const first = yield* h.account.setup("operator-digest");

      const state =
        new URL(first.authorizations[0]?.url ?? "").searchParams.get("state") ??
        "";

      h.time(initial + 600_000);
      expect(
        (yield* h.account
          .completeOAuth({ state, code: "code", operator: "operator-digest" })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      h.time(initial);
      const second = yield* h.account.setup("operator-digest");

      const other =
        new URL(second.authorizations[0]?.url ?? "").searchParams.get(
          "state",
        ) ?? "";

      expect(
        (yield* h.account
          .completeOAuth({ state: other, code: "code", operator: "wrong" })
          .pipe(Effect.flip)).code,
      ).toBe("state");
      const third = yield* h.account.setup("operator-digest");

      const old =
        new URL(third.authorizations[0]?.url ?? "").searchParams.get("state") ??
        "";

      const replacement = yield* h.construct("revision-two");
      expect(
        (yield* replacement.service
          .completeOAuth({
            state: old,
            code: "code",
            operator: "operator-digest",
          })
          .pipe(Effect.flip)).code,
      ).toBe("state");
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "personal identity requests the union of sender and broadcaster grants and awaits real ingress",
  Effect.gen(function* () {
    const personal = {
      ...fixtureConfig,
      senderKind: "personal",
      stage: "staging",
      senderLogin: "personal",
      channelLogins: ["personal"],
    } satisfies AccountIdentity;

    const h = yield* harness(personal, false);
    const first = yield* h.account.setup("operator-digest");
    expect(first.authorizations.length).toBe(1);
    expect(first.authorizations[0]?.roles).toEqual(["sender", "broadcaster"]);
    expect(
      new URL(first.authorizations[0]?.url ?? "").searchParams.get("scope"),
    ).toBe("user:read:chat user:write:chat user:bot channel:bot");
    const final = yield* h.authorize();
    expect(final.status.setup).toBe("ingress-required");
    expect(h.control.creates).toBe(0);
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        final.status,
      ).pipe(Effect.orDie),
    ).not.toContain("canary");
  }),
);

test(
  "setup adopts subscriptions, repeats without creation, repairs revocation and removes obsolete ownership",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const ready = yield* h.authorize();
      expect(ready.status.setup).toBe("ready");
      expect(h.control.creates).toBe(2);
      yield* h.account.setup("operator-digest");
      expect(h.control.creates).toBe(2);
      const original = h.control.remote[0];

      if (!original) return yield* Effect.die("missing fixture subscription");
      yield* h.account.observeSubscription({
        id: original.id,
        broadcasterId: yield* Schema.decodeEffect(
          Dispatch.fields.broadcasterId,
        )("200"),
        senderId: "100",
        binding: "fixture-binding",
        callback: "https://fixture.invalid/webhooks/twitch",
        status: "authorization_revoked",
      });
      expect((yield* h.account.status).sender?.authorized).toBeTrue();
      expect(yield* h.account.dispatch(h.send("revoked"))).toEqual({
        kind: "rejected",
      });
      h.control.remote = Arr.map(h.control.remote, (sub) =>
        sub.id === original.id
          ? { ...sub, status: "authorization_revoked" }
          : sub,
      );
      yield* h.authorize();
      expect(h.control.creates).toBe(3);
      expect(h.control.removes).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "token contention mints once, validates startup and refreshes at the hourly boundary",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      expect(h.control.mints).toBe(1);
      h.time(initial + 3_600_000);
      yield* Effect.all(
        [
          h.account.dispatch(h.send("one")),
          h.account.dispatch(h.send("two", "300")),
        ],
        { concurrency: "unbounded" },
      );
      expect(h.control.mints).toBe(2);
      const before = h.control.validations;
      const reconstructed = yield* h.construct();
      yield* reconstructed.service.dispatch(h.send("three"));
      expect(h.control.mints).toBe(2);
      expect(h.control.validations).toBe(before + 1);
      expect(h.alarmAt()).toBe(initial + 7_195_000);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "shared limits cross channels, honor retry time and stop at deadline equality",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      expect((yield* h.account.dispatch(h.send("first"))).kind).toBe("sent");
      const retry = h.send("second");
      const waiting = yield* h.account.dispatch(retry);
      expect(waiting.kind).toBe("retryable");

      if (waiting.kind === "retryable")
        expect(Number(waiting.retryAt)).toBe(initial + 1000);
      expect((yield* h.account.dispatch(h.send("other", "300"))).kind).toBe(
        "sent",
      );
      h.time(initial + 1000);
      expect((yield* h.account.dispatch(retry)).kind).toBe("sent");

      for (let i = 2; i < 19; i++) {
        h.time(initial + i * 1000);
        expect((yield* h.account.dispatch(h.send(`budget-${i}`))).kind).toBe(
          "sent",
        );
      }

      expect(h.control.sends).toBe(20);
      expect(
        yield* h.account.dispatch(h.send("global", "300", initial + 28_000)),
      ).toEqual({ kind: "expired" });
      const equality = h.send("equal", "300", h.now());
      expect(yield* h.account.dispatch(equality)).toEqual({ kind: "expired" });
      expect(h.control.sends).toBe(20);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

for (const result of [
  { kind: "rejected", code: "private-canary-drop" },
  { kind: "ambiguous" },
] satisfies SendResult[]) {
  test(
    `stable attempts retain ${result.kind} without another POST`,
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* h.authorize();
        h.control.result = result;
        const input = h.send("stable");
        expect(yield* h.account.dispatch(input)).toEqual({ kind: result.kind });
        expect(yield* h.account.dispatch(input)).toEqual({ kind: result.kind });
        const reconstructed = yield* h.construct();
        expect(yield* reconstructed.service.dispatch(input)).toEqual({
          kind: result.kind,
        });
        expect(h.control.sends).toBe(1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            yield* h.account.status,
          ).pipe(Effect.orDie),
        ).not.toContain("canary");
      }).pipe(Effect.provideService(Clock.Clock, h.clock));
    }),
  );
}

test(
  "reconstruction turns an interrupted non-idempotent POST into ambiguity and fences its late completion",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      h.control.sendGate = yield* Deferred.make<void>();
      h.control.sendStarted = yield* Deferred.make<void>();
      const input = h.send("interrupted");
      const fiber = yield* h.account.dispatch(input).pipe(Effect.forkChild);
      yield* Deferred.await(h.control.sendStarted);
      const reconstructed = yield* h.construct();
      expect(yield* reconstructed.service.dispatch(input)).toEqual({
        kind: "ambiguous",
      });
      yield* Deferred.succeed(h.control.sendGate, undefined);
      yield* Fiber.join(fiber);
      expect(yield* reconstructed.service.dispatch(input)).toEqual({
        kind: "ambiguous",
      });
      expect(h.control.sends).toBe(1);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "an explicit 401 invalidates only its token generation and a stable retry waits for the shared reservation",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      h.control.result = { kind: "unauthorized" };
      const input = h.send("retry-401");
      expect((yield* h.account.dispatch(input)).kind).toBe("retryable");
      expect(h.control.sends).toBe(1);
      h.control.result = { kind: "sent", messageId: "after-refresh" };
      h.time(initial + 1000);
      expect(yield* h.account.dispatch(input)).toEqual({
        kind: "sent",
        messageId: "after-refresh",
      });
      expect(h.control.mints).toBe(2);
      expect(h.control.sends).toBe(2);
      expect(yield* h.account.dispatch(input)).toEqual({
        kind: "sent",
        messageId: "after-refresh",
      });
      expect(h.control.sends).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "on-demand reclamation bounds the ledger and old absolute deadlines cannot create another message",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const first = h.send("retained-original");
      yield* h.account.dispatch(first);

      for (let index = 1; index < 64; index++) {
        h.time(initial + index * 30_000);
        expect(
          (yield* h.account.dispatch(h.send(`retained-${index}`))).kind,
        ).toBe("sent");
      }

      const status = yield* h.account.status;
      expect(status.attempts).toBeLessThanOrEqual(21);
      expect(yield* h.account.dispatch(first)).toEqual({ kind: "expired" });
      expect(h.control.sends).toBe(64);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "application-token client mismatch fails validation without persisting a credential",
  Effect.gen(function* () {
    const h = yield* harness();
    h.control.appClient = "different-application";
    expect(
      (yield* h.account.setup("operator-digest").pipe(Effect.flip)).code,
    ).toBe("client");
    expect((yield* h.account.status).credential).toBe("absent");
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        h.snapshot(),
      ).pipe(Effect.orDie),
    ).not.toContain("canary-app-token");
    expect(h.control.sends).toBe(0);
  }),
);

test(
  "scoped broadcaster removal preserves an unrelated sender OAuth already in flight",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      yield* h.store.update((state) => {
        delete state.grants["100"];
      });
      const pending = yield* h.account.setup("operator-digest");
      yield* h.store.update((state) => {
        state.grants["100"] = [...senderScopes];
      });

      const state =
        new URL(pending.authorizations[0]?.url ?? "").searchParams.get(
          "state",
        ) ?? "";

      h.control.grantUser = "100";
      h.control.grantLogin = "fixture_sender";
      h.control.grantScopes = [...senderScopes];
      h.control.exchangeGate = yield* Deferred.make<void>();
      h.control.exchangeStarted = yield* Deferred.make<void>();
      const before = h.control.exchanges;

      const completing = yield* h.account
        .completeOAuth({
          state,
          code: "canary-code",
          operator: "operator-digest",
        })
        .pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(h.control.exchangeStarted);
      expect(h.control.exchanges).toBe(before + 1);
      const subscription = h.control.remote[0];

      if (!subscription)
        return yield* Effect.die("missing fixture subscription");
      yield* h.account.observeSubscription({
        id: subscription.id,
        broadcasterId: Dispatch.fields.broadcasterId.make("200"),
        senderId: "100",
        binding: "fixture-binding",
        callback: "https://fixture.invalid/webhooks/twitch",
        status: "authorization_revoked",
      });
      yield* Deferred.succeed(h.control.exchangeGate, undefined);
      expect((yield* Fiber.join(completing))._tag).toBe("Success");
      expect(
        Arr.some(
          (yield* h.account.status).channels,
          (entry) => !!(entry.id === "200"),
        ),
      ).toBeFalse();
      expect((yield* h.account.status).sender?.authorized).toBeTrue();
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "a signing-secret binding change replaces known subscriptions instead of adopting an old secret",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      expect(h.control.creates).toBe(2);

      const replacement = yield* h.construct(
        "new-config",
        "new-signing-binding",
      );

      expect((yield* h.authorize(replacement.service)).status.setup).toBe(
        "ready",
      );
      expect(h.control.creates).toBe(4);
      expect(h.control.removes).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "verified subscription observations preserve enabled state across a stale pending list response",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const subscription = h.control.remote[0];

      if (!subscription)
        return yield* Effect.die("missing fixture subscription");
      h.control.remote = Arr.map(h.control.remote, (sub) => ({
        ...sub,
        status: "webhook_callback_verification_pending",
      }));

      for (const sub of h.control.remote)
        yield* h.account.observeSubscription({
          id: sub.id,
          broadcasterId: Dispatch.fields.broadcasterId.make(
            sub.condition.broadcaster_user_id ?? "",
          ),
          senderId: "100",
          binding: "fixture-binding",
          callback: "https://fixture.invalid/webhooks/twitch",
          status: "enabled",
        });
      expect((yield* h.account.setup("operator-digest")).status.setup).toBe(
        "ready",
      );
      expect(h.control.creates).toBe(2);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "an authorization rejection is durable even if setup repairs the account before the original deadline",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const input = h.send("rejected-before-setup");
      expect(yield* h.account.dispatch(input)).toEqual({ kind: "rejected" });
      yield* h.authorize();
      expect(yield* h.account.dispatch(input)).toEqual({ kind: "rejected" });
      expect(h.control.sends).toBe(0);
    }).pipe(Effect.provideService(Clock.Clock, h.clock));
  }),
);

test(
  "localhost OAuth support never permits HTTP or non-443 webhook callbacks",
  Effect.gen(function* () {
    const h = yield* harness();

    const local = yield* h.construct(
      "local-oauth",
      "fixture-binding",
      fixtureConfig,
      "http://localhost:3000",
    );

    expect(
      (yield* local.service.setup("operator-digest")).authorizations.length,
    ).toBeGreaterThan(0);

    for (const webhook of [
      "http://localhost:3000",
      "http://remote.invalid",
      "https://remote.invalid:3000",
      "https://user@remote.invalid",
      "https://remote.invalid?x=1",
    ]) {
      const account = yield* h.construct(
        "bad-webhook",
        "fixture-binding",
        fixtureConfig,
        "http://localhost:3000",
        webhook,
      );

      expect(
        (yield* account.service.setup("operator-digest").pipe(Effect.flip))
          .code,
      ).toBe("configuration");
    }
  }),
);
