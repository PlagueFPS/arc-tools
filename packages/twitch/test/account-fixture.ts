import {
  type AccountStorage,
  accountStorageLayer,
} from "@arctools/twitch/cloudflare";
import type { AccountIdentity } from "@arctools/twitch/server";
import {
  type Account,
  AccountError,
  Dispatch,
  type SetupResult,
} from "@arctools/twitch/server";
import {
  senderScopes,
  AccountService,
  accountServiceLayer,
  type Provider,
  type SendResult,
  type Subscription,
  TwitchProvider,
  AccountState,
  AccountStore,
  emptyState,
} from "@arctools/twitch/testing";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Clock, Deferred, Effect, Schema, Semaphore } from "effect";

export const initial = 1_000_000_000_000;

export const fixtureConfig = {
  kind: "test",
  stage: "test-account-0123456789ab",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel", "fixture_other"],
  twitchClientId: "fixture-twitch",
} satisfies AccountIdentity;

export const harness = Effect.fnUntraced(function* (
  identity: AccountIdentity = fixtureConfig,
  webhookReady = true,
) {
  const clock = yield* Clock.Clock;
  let time = initial;
  let raw: unknown = emptyState("");
  const mutex = yield* Semaphore.make(1);
  let nativeAlarm: number | null = null;
  let nextReadElapsedMs = 0;

  const storage: AccountStorage = {
    get: () =>
      Effect.sync(() => {
        time += nextReadElapsedMs;
        nextReadElapsedMs = 0;

        return structuredClone(raw);
      }),
    put: (_key, value) =>
      Effect.sync(() => {
        raw = structuredClone(value);
      }),
    transaction: (effect) => effect.pipe(mutex.withPermit),
    getAlarm: () => Effect.sync(() => nativeAlarm),
    setAlarm: (value) =>
      Effect.sync(() => {
        nativeAlarm = Number(value);
      }),
    deleteAlarm: () =>
      Effect.sync(() => {
        nativeAlarm = null;
      }),
  };

  const store = yield* AccountStore.pipe(
    Effect.provide(accountStorageLayer(storage)),
  ).pipe(
    Effect.provideService(RuntimeContext, {
      Type: "test",
      id: "account-storage",
      env: {},
      get: () => Effect.succeed(undefined),
      set: (key) => Effect.succeed(key),
    }),
  );

  const noGate = (): Deferred.Deferred<void> | null => null;

  const defaultResult = (): SendResult => ({
    kind: "sent",
    messageId: "message-one",
  });

  const subscriptionStatus = ():
    | "enabled"
    | "webhook_callback_verification_pending" => "enabled";

  const noFailure = (): "client" | "provider" | null => null;
  const remoteBindings: Record<string, string> = {};
  const usersTokens: string[] = [];
  const sendTokens: string[] = [];
  const remote: Subscription[] = [];

  const control = {
    userIds: new Map<string, string>(),
    subscriptionStatus: subscriptionStatus(),
    grantClient: identity.twitchClientId,
    grantExpires: 3600,
    grantUser: "100",
    grantLogin: identity.senderLogin,
    grantScopes: [...senderScopes],
    appClient: identity.twitchClientId,
    appExpires: 3600,
    sends: 0,
    mints: 0,
    validations: 0,
    exchanges: 0,
    exchangeElapsedMs: 0,
    grantValidationElapsedMs: 0,
    usersElapsedMs: 0,
    sleepProviderDelays: false,
    createGate: noGate(),
    lists: 0,
    creates: 0,
    removes: 0,
    result: defaultResult(),
    sendGate: noGate(),
    mintGate: noGate(),
    exchangeGate: noGate(),
    exchangeStarted: noGate(),
    validationGate: noGate(),
    failCreate: false,
    failUsers: false,
    usersFailure: noFailure(),
    usersGate: noGate(),
    listGate: noGate(),
    usersTokens,
    sendTokens,
    remoteBindings,
    binding: "fixture-binding",
    remote,
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

      if (control.exchangeStarted)
        yield* Deferred.succeed(control.exchangeStarted, undefined);
      time += control.exchangeElapsedMs;

      if (control.sleepProviderDelays)
        yield* Effect.sleep(control.exchangeElapsedMs);

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
              expires_in: control.grantExpires,
              user_id: control.grantUser,
              login: control.grantLogin,
              scopes: control.grantScopes,
            };

      if (token === "canary-app-token" && control.validationGate)
        yield* Deferred.await(control.validationGate);

      if (token !== "canary-app-token") {
        time += control.grantValidationElapsedMs;

        if (control.sleepProviderDelays)
          yield* Effect.sleep(control.grantValidationElapsedMs);
      }

      return result;
    }),
    users: Effect.fnUntraced(function* (token, logins) {
      control.usersTokens.push(token);
      time += control.usersElapsedMs;

      if (control.sleepProviderDelays)
        yield* Effect.sleep(control.usersElapsedMs);
      const failure = control.failUsers ? "client" : control.usersFailure;

      if (control.usersGate) yield* Deferred.await(control.usersGate);

      if (failure) return yield* new AccountError({ code: failure });

      return logins.map((login) => ({
        login,
        id:
          control.userIds.get(login) ??
          (login === identity.senderLogin
            ? "100"
            : login === "fixture_channel"
              ? "200"
              : login === "fixture_other"
                ? "300"
                : String(400 + logins.indexOf(login))),
      }));
    }),
    list: Effect.fnUntraced(function* () {
      control.lists++;

      if (control.listGate) yield* Deferred.await(control.listGate);

      return [...control.remote];
    }),
    create: (_token, channel, sender) =>
      Effect.sync(() => {
        control.creates++;
        const id = `sub-${channel}-${control.creates}`;
        control.remoteBindings[id] = control.binding;

        const subscription: Subscription = {
          id,
          type: "channel.chat.message",
          version: "1",
          status: control.subscriptionStatus,
          condition: { broadcaster_user_id: channel, user_id: sender },
          transport: {
            method: "webhook",
            callback: "https://fixture.invalid/webhooks/twitch",
          },
        };

        control.remote.push(subscription);

        if (control.failCreate)
          return { kind: "unknown" } satisfies Effect.Success<
            ReturnType<Provider["create"]>
          >;

        return {
          kind: "created",
          subscription: {
            id,
            broadcasterId: channel,
            senderId: sender,
            callback: subscription.transport.callback ?? "",
            binding: control.binding,
            status: control.subscriptionStatus,
          },
        } satisfies Effect.Success<ReturnType<Provider["create"]>>;
      }).pipe(
        Effect.tap(() =>
          control.createGate ? Deferred.await(control.createGate) : Effect.void,
        ),
      ),
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
    configuredIdentity = identity,
  ) => {
    control.binding = subscriptionBinding;

    return AccountService.pipe(
      Effect.provide(
        accountServiceLayer({
          identity: configuredIdentity,
          webhookReady,
          subscriptionBinding,
          revision,
          callback: "https://fixture.invalid/webhooks/twitch",
          redirect: "https://fixture.invalid/oauth/twitch/callback",
        }),
      ),
    ).pipe(
      Effect.provideService(AccountStore, store),
      Effect.provideService(TwitchProvider, provider),
    );
  };

  const account = yield* construct();

  return {
    account: account.service,
    alarm: account.credentialAlarm,
    enrollment: account.enrollment,
    construct,
    control,
    clock: fakeClock,
    time: (value: number) => {
      time = value;
    },
    now: () => time,
    delayNextReadBy: (elapsedMs: number) => {
      nextReadElapsedMs = elapsedMs;
    },
    snapshot: () => raw,
    restoreRaw: (value: typeof AccountState.Encoded) => {
      raw = structuredClone(value);
    },
    restore: (value: AccountState) => {
      raw = Schema.encodeSync(AccountState)(value);
    },
    alarmAt: () =>
      Schema.decodeUnknownSync(AccountState)(raw).nextCredentialCheck,
    nativeAlarmAt: () => nativeAlarm,
    consumeAlarm: () => {
      nativeAlarm = null;
    },
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
              : authorization.login === "fixture_other"
                ? "300"
                : String(
                    400 +
                      [
                        ...new Set([
                          identity.senderLogin,
                          ...identity.channelLogins,
                        ]),
                      ].indexOf(authorization.login),
                  );

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
