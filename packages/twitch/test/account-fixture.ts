/* oxlint-disable effecttsgo/run-effect-inside-effect -- Native fixture callbacks need synchronous values or Promises from the simulated Effect services. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
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
  makeAccount,
  type Provider,
  type SendResult,
  type Subscription,
  TwitchProvider,
  AccountState,
  AccountStore,
  SharedAccount,
  ChannelRecord,
  splitAccount,
  nextAlarm,
} from "@arctools/twitch/testing";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Schema,
  Semaphore,
  Array as Arr,
  Record as Rec,
  String as Str,
  Option,
} from "effect";

export const initial = 1_000_000_000_000;

export const fixtureConfig = {
  senderKind: "synthetic",
  stage: "test-account-0123456789ab",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel", "fixture_other"],
  twitchClientId: "fixture-twitch",
} satisfies AccountIdentity;

export const keyedStorage = Effect.fnUntraced(function* (
  onRead: () => void = () => {},
) {
  const values = new Map<string, unknown>();
  const traces: { operation: string; key: string }[] = [];
  const mutex = yield* Semaphore.make(1);
  let nativeAlarm: number | null = null;
  const control = { failAt: 0, mutations: 0 };

  const mutation = () => {
    control.mutations++;

    if (control.failAt === control.mutations)
      throw new Error("Injected storage failure");
  };

  const storage: AccountStorage = {
    get: (key) =>
      Effect.sync(() => {
        traces.push({ operation: "get", key });
        onRead();

        return structuredClone(values.get(key));
      }),
    list: ({ prefix }) =>
      Effect.sync(() => {
        traces.push({ operation: "list", key: prefix });

        return structuredClone(
          new Map(
            Arr.filter(
              [...values],
              ([key]) => !!Str.startsWith(prefix)(key),
            ).sort(([a], [b]) => Str.localeCompare(b)(a)),
          ),
        );
      }),
    put: (key, value) =>
      Effect.sync(() => {
        traces.push({ operation: "put", key });
        values.set(key, structuredClone(value));
        mutation();
      }),
    delete: (key) =>
      Effect.sync(() => {
        traces.push({ operation: "delete", key });
        const deleted = values.delete(key);
        mutation();

        return deleted;
      }),
    transaction: (effect) =>
      Effect.gen(function* () {
        const before = structuredClone(values);
        const alarm = nativeAlarm;
        const exit = yield* Effect.exit(effect);

        if (Exit.isFailure(exit)) {
          values.clear();

          for (const [key, value] of before) values.set(key, value);
          nativeAlarm = alarm;

          return yield* Effect.failCause(exit.cause);
        }

        return exit.value;
      }).pipe((effect) => mutex.withPermit(effect)),
    getAlarm: () => Effect.sync(() => nativeAlarm),
    setAlarm: (value) =>
      Effect.sync(() => {
        traces.push({ operation: "setAlarm", key: "alarm" });
        nativeAlarm = Number(value);
        mutation();
      }),
    deleteAlarm: () =>
      Effect.sync(() => {
        traces.push({ operation: "deleteAlarm", key: "alarm" });
        nativeAlarm = null;
        mutation();
      }),
  };

  return {
    storage,
    values,
    traces,
    control,
    restore: (value: AccountState) => {
      const directory = splitAccount(structuredClone(value));
      values.clear();
      values.set(
        "account:shared:v1",
        Schema.encodeSync(SharedAccount)(directory.shared),
      );
      values.set(
        "account:oauth:v1",
        Schema.encodeSync(AccountState.fields.oauth)(directory.oauth),
      );
      values.set(
        "account:attempts:v1",
        Schema.encodeSync(AccountState.fields.attempts)(directory.attempts),
      );
      values.set(
        "account:enrollments:v1",
        Schema.encodeSync(AccountState.fields.enrollments)(
          directory.enrollments,
        ),
      );

      for (const [id, record] of directory.channels)
        values.set(
          "account:channel:v1/" + encodeURIComponent(id),
          Schema.encodeSync(ChannelRecord)(record),
        );

      for (const [id, tombstone] of Rec.toEntries(directory.revoked))
        values.set(
          "account:tombstone:v1/" + encodeURIComponent(id),
          Schema.encodeSync(AccountState.fields.revoked.value)(tombstone),
        );
      nativeAlarm = nextAlarm(directory.shared);
    },
    alarm: () => nativeAlarm,
    consumeAlarm: () => {
      nativeAlarm = null;
    },
  };
});

export const harness = Effect.fnUntraced(function* (
  identity: AccountIdentity = fixtureConfig,
  webhookReady = true,
) {
  const clock = yield* Clock.Clock;
  let time = initial;
  let nextReadElapsedMs = 0;

  const memory = yield* keyedStorage(() => {
    time += nextReadElapsedMs;
    nextReadElapsedMs = 0;
  });

  const { storage } = memory;

  const store = yield* AccountStore.pipe(
    Effect.provide(accountStorageLayer(storage)),
    Effect.provideService(RuntimeContext, {
      Type: "test",
      id: "account-storage",
      env: {},
      get: () => Effect.as(Effect.void, undefined),
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
    createStarted: noGate(),
    lists: 0,
    creates: 0,
    removes: 0,
    result: defaultResult(),
    sendGate: noGate(),
    sendStarted: noGate(),
    mintGate: noGate(),
    mintStarted: noGate(),
    exchangeGate: noGate(),
    exchangeStarted: noGate(),
    validationGate: noGate(),
    validationStarted: noGate(),
    failCreate: false,
    failRemove: false,
    removeElapsedMs: 0,
    removeRetryAt: 0,
    failedChannels: new Set<string>(),
    failUsers: false,
    usersFailure: noFailure(),
    usersGate: noGate(),
    usersStarted: noGate(),
    listGate: noGate(),
    listStarted: noGate(),
    usersTokens,
    sendTokens,
    remoteBindings,
    binding: "fixture-binding",
    remote,
  };

  const provider: Provider = {
    mint: Effect.gen(function* () {
      control.mints++;

      if (control.mintStarted)
        yield* Deferred.succeed(control.mintStarted, undefined);

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

      if (control.validationStarted)
        yield* Deferred.succeed(control.validationStarted, undefined);

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

      if (control.usersStarted)
        yield* Deferred.succeed(control.usersStarted, undefined);
      time += control.usersElapsedMs;

      if (control.sleepProviderDelays)
        yield* Effect.sleep(control.usersElapsedMs);
      const failure = control.failUsers ? "client" : control.usersFailure;

      if (control.usersGate) yield* Deferred.await(control.usersGate);

      if (failure) return yield* new AccountError({ code: failure });

      return Arr.map(logins, (login) => ({
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

      if (control.listStarted)
        yield* Deferred.succeed(control.listStarted, undefined);

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

        if (control.failCreate || control.failedChannels.has(channel))
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
          control.createStarted
            ? Deferred.succeed(control.createStarted, undefined)
            : Effect.void,
        ),
        Effect.tap(() =>
          control.createGate ? Deferred.await(control.createGate) : Effect.void,
        ),
      ),
    remove: (_token, id) =>
      Effect.gen(function* () {
        time += control.removeElapsedMs;

        if (control.failRemove)
          return yield* new AccountError({
            code: "provider",
            retryAt: control.removeRetryAt || undefined,
          });
        yield* Effect.sync(() => {
          control.removes++;

          control.remote = Arr.filter(
            control.remote,
            (sub) => !!(sub.id !== id),
          );
        });
      }),
    send: Effect.fnUntraced(function* (_token, _sender, input) {
      if (time >= input.deadline) return { kind: "expired" };
      control.sends++;
      control.sendTokens.push(_token);

      if (control.sendStarted)
        yield* Deferred.succeed(control.sendStarted, undefined);

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
    oauthOrigin = "https://fixture.invalid",
    webhookOrigin = "https://fixture.invalid",
  ) => {
    control.binding = subscriptionBinding;

    return makeAccount({
      identity: configuredIdentity,
      webhookReady,
      subscriptionBinding,
      revision,
      callback: `${webhookOrigin}/webhooks/twitch`,
      redirect: `${oauthOrigin}/oauth/twitch/callback`,
    }).pipe(
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
    store,
    memory,
    snapshot: () =>
      Effect.runSync(store.update((state) => structuredClone(state))),
    restoreRaw: (value: typeof AccountState.Encoded) => {
      memory.restore(
        Schema.decodeSync(AccountState, { onExcessProperty: "error" })(value),
      );
    },
    restore: memory.restore,
    alarmAt: () =>
      Effect.runSync(store.shared((state) => state.nextCredentialCheck)),
    nativeAlarmAt: memory.alarm,
    consumeAlarm: memory.consumeAlarm,
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
        control.grantScopes =
          Option.getOrUndefined(
            Option.map(
              Option.fromNullishOr(url.searchParams.get("scope")),
              (effectNativeValue0) => Str.split(effectNativeValue0, " "),
            ),
          ) ?? [];
        yield* target.completeOAuth({
          state: url.searchParams.get("state") ?? "",
          code: "canary-code",
          operator: "operator-digest",
        });
      }

      return yield* target.setup("operator-digest");
    }),
    send: (attemptId: string, channel = "200", deadline = time + 10_000) =>
      Schema.decodeSync(Dispatch)({
        attemptId,
        broadcasterId: channel,
        source: (() => {
          const row = memory.values.get("account:channel:v1/" + channel);

          if (!row)
            return { installationId: "unowned", subscriptionId: "unowned" };
          const record = Schema.decodeUnknownSync(ChannelRecord)(row);

          return record.lifecycle?.kind === "installed" && record.subscription
            ? {
                installationId: record.lifecycle.id,
                subscriptionId: record.subscription.id,
              }
            : { installationId: "unowned", subscriptionId: "unowned" };
        })(),
        replyParentId: "reply",
        text: "Sensors sell for 10 coins.",
        deadline,
      }),
  };
});
