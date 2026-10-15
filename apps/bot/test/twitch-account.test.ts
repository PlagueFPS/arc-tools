import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Semaphore,
} from "effect";
import { EnvironmentConfig } from "../src/config.js";
import { makeAccount, senderScopes } from "../src/twitch-account.js";
import {
  type Account,
  AccountError,
  Dispatch,
  type SetupResult,
} from "../src/twitch-contracts.js";
import {
  type Provider,
  type SendResult,
  type Subscription,
  TwitchProvider,
} from "../src/twitch-provider.js";
import { AccountState, AccountStore, emptyState } from "../src/twitch-state.js";

const { test } = Test.make({ providers: Layer.empty });
const initial = 1_000_000_000_000;
const fixtureConfig = Schema.decodeUnknownSync(EnvironmentConfig)({
  kind: "test",
  stage: "test-account-0123456789ab",
  applicationStage: "test-account-0123456789ab",
  senderKind: "synthetic",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel", "fixture_other"],
  twitchClientId: "fixture-twitch",
  discordApplicationId: "fixture-discord",
});
const harness = Effect.fnUntraced(function* (
  identity = fixtureConfig,
  webhookReady = true,
) {
  const clock = yield* Clock.Clock;
  let time = initial;
  let raw: unknown = emptyState("");
  const mutex = yield* Semaphore.make(1);
  const store = AccountStore.of({
    update: (f) =>
      Effect.sync(() => {
        const state: AccountState = Schema.decodeUnknownSync(AccountState)(
          structuredClone(raw),
        );
        const result = f(state);
        raw = Schema.encodeSync(AccountState)(state);
        return result;
      }).pipe(mutex.withPermit),
  });
  const noGate = (): Deferred.Deferred<void> | null => null;
  const defaultResult = (): SendResult => ({
    kind: "sent",
    messageId: "message-one",
  });
  const control = {
    grantClient: identity.twitchClientId,
    grantUser: "100",
    grantLogin: identity.senderLogin,
    grantScopes: [...senderScopes],
    appClient: identity.twitchClientId,
    appExpires: 3600,
    sends: 0,
    mints: 0,
    validations: 0,
    exchanges: 0,
    creates: 0,
    removes: 0,
    result: defaultResult(),
    sendGate: noGate(),
    mintGate: noGate(),
    exchangeGate: noGate(),
    validationGate: noGate(),
    failCreate: false,
    failUsers: false,
    usersTokens: [] as string[],
    sendTokens: [] as string[],
    remoteBindings: {} as Record<string, string>,
    binding: "fixture-binding",
    remote: [] as Subscription[],
  };
  const provider: Provider = {
    mint: Effect.fnUntraced(function* () {
      control.mints++;
      if (control.mintGate) yield* Deferred.await(control.mintGate);
      return {
        access_token: "canary-app-token",
        token_type: "bearer",
        expires_in: control.appExpires,
      };
    }),
    exchange: Effect.fnUntraced(function* () {
      control.exchanges++;
      if (control.exchangeGate) yield* Deferred.await(control.exchangeGate);
      return {
        access_token: "canary-user-token",
        token_type: "bearer",
        expires_in: 3600,
      };
    }),
    validate: Effect.fnUntraced(function* (token) {
      control.validations++;
      const result =
        token === "canary-app-token"
          ? {
              client_id: control.appClient,
              expires_in: control.appExpires,
              scopes: null,
            }
          : {
              client_id: control.grantClient,
              expires_in: 3600,
              user_id: control.grantUser,
              login: control.grantLogin,
              scopes: control.grantScopes,
            };
      if (token === "canary-app-token" && control.validationGate)
        yield* Deferred.await(control.validationGate);
      return result;
    }),
    users: Effect.fnUntraced(function* (token, logins) {
      control.usersTokens.push(token);
      if (control.failUsers) return yield* new AccountError({ code: "client" });
      return logins.map((login) => ({
        login,
        id:
          login === identity.senderLogin
            ? "100"
            : login === "fixture_channel"
              ? "200"
              : login === "fixture_other"
                ? "300"
                : String(400 + logins.indexOf(login)),
      }));
    }),
    list: () => Effect.sync(() => [...control.remote]),
    create: (_token, channel, sender) =>
      Effect.gen(function* () {
        control.creates++;
        const id = `sub-${channel}-${control.creates}`;
        control.remoteBindings[id] = control.binding;
        control.remote.push({
          id,
          type: "channel.chat.message",
          version: "1",
          status: "enabled",
          condition: { broadcaster_user_id: channel, user_id: sender },
          transport: {
            method: "webhook",
            callback: "https://fixture.invalid/webhooks/twitch",
          },
        });
        if (control.failCreate)
          return yield* new AccountError({ code: "provider" });
      }),
    remove: (_token, id) =>
      Effect.sync(() => {
        control.removes++;
        control.remote = control.remote.filter((sub) => sub.id !== id);
      }),
    send: Effect.fnUntraced(function* (_token, _sender, input) {
      if (time >= input.deadline) return { kind: "expired" };
      control.sends++;
      control.sendTokens.push(_token);
      if (control.sendGate) yield* Deferred.await(control.sendGate);
      return control.result;
    }),
  };
  const fakeClock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => time),
    currentTimeMillisUnsafe: () => time,
    currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    monotonicTimeNanos: clock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => clock.sleep(duration),
  };
  const construct = (
    revision = "revision-one",
    subscriptionBinding = "fixture-binding",
  ) =>
    makeAccount({
      identity,
      webhookReady,
      subscriptionBinding,
      revision,
      callback: "https://fixture.invalid/webhooks/twitch",
      redirect: "https://fixture.invalid/oauth/twitch/callback",
    }).pipe(
      Effect.provideService(AccountStore, store),
      Effect.provideService(TwitchProvider, provider),
    );
  const account = yield* construct();
  return {
    account: account.service,
    alarm: account.credentialAlarm,
    construct,
    control,
    clock: fakeClock,
    time: (value: number) => {
      time = value;
    },
    now: () => time,
    snapshot: () => raw,
    restore: (value: AccountState) => {
      raw = Schema.encodeSync(AccountState)(value);
    },
    alarmAt: () =>
      Schema.decodeUnknownSync(AccountState)(raw).nextCredentialCheck,
    authorize: Effect.fnUntraced(function* (
      target: Account = account.service,
    ): Effect.fn.Return<SetupResult, AccountError> {
      const setup = yield* target.setup("operator-digest");
      for (const authorization of setup.authorizations) {
        const url = new URL(authorization.url);
        const user =
          authorization.login === identity.senderLogin
            ? "100"
            : authorization.login === "fixture_channel"
              ? "200"
              : "300";
        control.grantUser = user;
        control.grantLogin = authorization.login;
        control.grantScopes = url.searchParams.get("scope")?.split(" ") ?? [];
        yield* target.completeOAuth({
          state: url.searchParams.get("state") ?? "",
          code: "canary-code",
          operator: "operator-digest",
        });
      }
      return yield* target.setup("operator-digest");
    }),
    send: (attemptId: string, channel = "200", deadline = time + 10_000) =>
      Schema.decodeUnknownSync(Dispatch)({
        attemptId,
        broadcasterId: channel,
        replyParentId: "reply",
        text: "Sensors sell for 10 coins.",
        deadline,
      }),
  };
});

test(
  "recovery schedules the next credential action when an existing session has an unexpired lease",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* h.authorize();
      const persisted = Schema.decodeUnknownSync(AccountState)(h.snapshot());
      const until = initial + 10_000;
      h.restore({ ...persisted, tokenLease: { owner: "interrupted", until } });
      const recovered = yield* h.construct();
      const validations = h.control.validations;
      h.time(initial + 1);
      yield* recovered.credentialAlarm();
      expect(h.control.validations).toBe(validations);
      expect(h.alarmAt()).toBe(until);
      h.time(until);
      yield* recovered.credentialAlarm();
      expect(h.control.validations).toBe(validations + 1);
      expect(h.alarmAt()).toBeGreaterThan(until);
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
      h.control.result = { kind: "unauthorized" };
      const send = yield* h.account
        .dispatch(h.send("overlapping-401"))
        .pipe(Effect.forkChild);
      for (let i = 0; i < 100 && h.control.sends === 0; i++)
        yield* Effect.yieldNow;
      expect(h.control.sends).toBe(1);
      h.time(initial + 3_600_000);
      h.control.validationGate = yield* Deferred.make<void>();
      const before = h.control.validations;
      const checking = yield* h.alarm().pipe(Effect.forkChild);
      for (let i = 0; i < 100 && h.control.validations === before; i++)
        yield* Effect.yieldNow;
      expect(h.control.validations).toBe(before + 1);
      yield* Deferred.succeed(h.control.sendGate, undefined);
      yield* Fiber.join(send);
      expect((yield* h.account.status()).credential).toBe("absent");
      yield* Deferred.succeed(h.control.validationGate, undefined);
      yield* Fiber.join(checking);
      expect((yield* h.account.status()).credential).toBe("absent");
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
        expect(
          (yield* h.authorize(rotated.service).pipe(Effect.flip)).code,
        ).toBe("provider");
        expect(
          h.control.remote.some(
            (sub) => h.control.remoteBindings[sub.id] === binding,
          ),
        ).toBeTrue();
      }
      h.control.binding = "binding-d";
      h.control.failCreate = false;
      const final = yield* h.construct("binding-d", "binding-d");
      expect((yield* h.authorize(final.service)).status.setup).toBe("ready");
      expect(
        h.control.remote.map((sub) => h.control.remoteBindings[sub.id]),
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
  "ordinary interrupted subscription creation adopts the durable intended binding",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      h.control.failCreate = true;
      expect((yield* h.authorize().pipe(Effect.flip)).code).toBe("provider");
      const existing = h.control.remote[0]?.id;
      expect(existing).toBeDefined();
      h.control.failCreate = false;
      const recovered = yield* h.construct();
      expect(
        (yield* recovered.service.setup("operator-digest")).status.setup,
      ).toBe("ready");
      expect(h.control.remote[0]?.id).toBe(existing);
      expect(h.control.creates).toBe(2);
      expect(h.control.removes).toBe(0);
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
      expect((yield* h.account.status()).credential).toBe("absent");
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
  "32 channels and a distinct sender allocate all links atomically across repeats and expiry",
  Effect.gen(function* () {
    const identity = Schema.decodeUnknownSync(EnvironmentConfig)({
      ...fixtureConfig,
      channelLogins: Array.from(
        { length: 32 },
        (_, i) => `fixture_channel_${i}`,
      ),
    });
    const h = yield* harness(identity);
    yield* Effect.gen(function* () {
      for (let repeat = 0; repeat < 4; repeat++) {
        const setup = yield* h.account.setup("operator-digest");
        expect(setup.authorizations.length).toBe(33);
        expect(
          new Set(setup.authorizations.map((auth) => auth.login)).size,
        ).toBe(33);
        const persisted = Schema.decodeUnknownSync(AccountState)(h.snapshot());
        expect(persisted.oauth.length).toBe(33);
        expect(
          persisted.oauth.every((state) =>
            setup.authorizations.some((auth) => auth.login === state.login),
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
        Schema.decodeUnknownSync(AccountState)(h.snapshot()).oauth.length,
      ).toBe(33);
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
      expect((yield* h.account.status()).sender?.authorized).toBeFalse();
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
    const personal = Schema.decodeUnknownSync(EnvironmentConfig)({
      ...fixtureConfig,
      kind: "personal",
      stage: "staging",
      applicationStage: "staging",
      senderKind: "personal",
      senderLogin: "personal",
      channelLogins: ["personal"],
    });
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
    expect(JSON.stringify(final.status)).not.toContain("canary");
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
        broadcasterId: Schema.decodeUnknownSync(Dispatch.fields.broadcasterId)(
          "200",
        ),
        senderId: "100",
        status: "authorization_revoked",
      });
      expect((yield* h.account.status()).sender?.authorized).toBeFalse();
      expect(yield* h.account.dispatch(h.send("revoked"))).toEqual({
        kind: "rejected",
      });
      h.control.remote = h.control.remote.map((sub) =>
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
        expect(JSON.stringify(yield* h.account.status())).not.toContain(
          "canary",
        );
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
      const input = h.send("interrupted");
      const fiber = yield* h.account.dispatch(input).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      while (h.control.sends === 0) yield* Effect.yieldNow;
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
      const status = yield* h.account.status();
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
    expect((yield* h.account.status()).credential).toBe("absent");
    expect(JSON.stringify(h.snapshot())).not.toContain("canary-app-token");
    expect(h.control.sends).toBe(0);
  }),
);

test(
  "revocation fences an OAuth exchange that was already in flight",
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      const pending = yield* h.account.setup("operator-digest");
      const state =
        new URL(pending.authorizations[0]?.url ?? "").searchParams.get(
          "state",
        ) ?? "";
      yield* h.authorize();
      h.control.grantUser = "100";
      h.control.grantLogin = "fixture_sender";
      h.control.grantScopes = [...senderScopes];
      h.control.exchangeGate = yield* Deferred.make<void>();
      const before = h.control.exchanges;
      const completing = yield* h.account
        .completeOAuth({
          state,
          code: "canary-code",
          operator: "operator-digest",
        })
        .pipe(Effect.exit, Effect.forkChild);
      for (
        let index = 0;
        index < 100 && h.control.exchanges === before;
        index++
      )
        yield* Effect.yieldNow;
      expect(h.control.exchanges).toBe(before + 1);
      const subscription = h.control.remote[0];
      if (!subscription)
        return yield* Effect.die("missing fixture subscription");
      yield* h.account.observeSubscription({
        id: subscription.id,
        broadcasterId: Dispatch.fields.broadcasterId.make("200"),
        senderId: "100",
        status: "authorization_revoked",
      });
      yield* Deferred.succeed(h.control.exchangeGate, undefined);
      expect((yield* Fiber.join(completing))._tag).toBe("Failure");
      expect((yield* h.account.status()).setup).toBe("repair-required");
      expect((yield* h.account.status()).sender?.authorized).toBeFalse();
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
      h.control.remote = h.control.remote.map((sub) => ({
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
