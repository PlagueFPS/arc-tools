import * as Cloudflare from "@alchemy.run/cloudflare";
import { providerTransport } from "@arctools/utils/http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

import {
  AccountService,
  accountServiceLayer,
  type AccountIdentity,
} from "./account.js";
import { subscriptionBinding } from "./binding.js";
import {
  AccountError,
  AccountStatus,
  DispatchOutcome,
  SetupResult,
  EnrollmentStatus,
  TwitchEnrollment,
  TwitchAccount,
} from "./contracts.js";
import { TwitchProvider, providerLayer } from "./provider.js";
import {
  AccountState,
  AccountStore,
  SharedAccount,
  ChannelRecord,
  type AccountDirectory,
  type ChannelDispatchState,
  emptyState,
  nextAlarm,
  splitAccount,
  joinDirectory,
} from "./state.js";

type NativeStorage = Cloudflare.DurableObjectState["Service"]["storage"];

export type AccountStorage = Pick<
  NativeStorage,
  "getAlarm" | "setAlarm" | "deleteAlarm"
> & {
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>;
  readonly put: <A>(
    key: string,
    value: A,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly list: (options: {
    prefix: string;
  }) => Effect.Effect<Map<string, unknown>, never, RuntimeContext>;
  readonly delete: (
    key: string,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly transaction: <A, R>(
    effect: Effect.Effect<A, never, R>,
  ) => Effect.Effect<A, unknown, R | RuntimeContext>;
};

const sharedKey = "account:shared:v1";

const channelPrefix = "account:channel:v1/";

const tombstonePrefix = "account:tombstone:v1/";

const oauthKey = "account:oauth:v1";

const attemptsKey = "account:attempts:v1";

const enrollmentsKey = "account:enrollments:v1";

export const makeAccountStorage = Effect.fnUntraced(function* (
  storage: AccountStorage,
) {
  const runtime = yield* RuntimeContext;

  const read = Effect.fnUntraced(function* <A, I>(
    key: string,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(yield* storage.get(key)).pipe(Effect.orDie);
  });

  const write = Effect.fnUntraced(function* <A, I>(
    key: string,
    schema: Schema.Codec<A, I>,
    value: A,
  ) {
    const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
      Effect.orDie,
    );

    if (
      new TextEncoder().encode(JSON.stringify(encoded)).byteLength >
      120 * 1024
    )
      return yield* Effect.die("Account record storage capacity exceeded");
    yield* storage.put(key, encoded);
  });

  const changed = Effect.fnUntraced(function* <A, I>(
    key: string,
    schema: Schema.Codec<A, I>,
    before: string,
    value: A,
  ) {
    if (before !== JSON.stringify(value)) yield* write(key, schema, value);
  });

  const alarm = Effect.fnUntraced(function* (shared: SharedAccount) {
    const due = nextAlarm(shared);

    if ((yield* storage.getAlarm()) !== due)
      yield* due === null ? storage.deleteAlarm() : storage.setAlarm(due);
  });

  const persistDirectory = Effect.fnUntraced(function* (
    after: AccountDirectory,
    before: AccountDirectory,
  ) {
    yield* changed(
      oauthKey,
      AccountState.fields.oauth,
      JSON.stringify(before.oauth),
      after.oauth,
    );
    yield* changed(
      attemptsKey,
      AccountState.fields.attempts,
      JSON.stringify(before.attempts),
      after.attempts,
    );
    yield* changed(
      enrollmentsKey,
      AccountState.fields.enrollments,
      JSON.stringify(before.enrollments),
      after.enrollments,
    );

    for (const [id, record] of after.channels)
      yield* changed(
        channelPrefix + encodeURIComponent(id),
        ChannelRecord,
        JSON.stringify(before.channels.get(id)) ?? "",
        record,
      );

    for (const id of before.channels.keys())
      if (!after.channels.has(id))
        yield* storage.delete(channelPrefix + encodeURIComponent(id));

    for (const [id, tombstone] of Object.entries(after.revoked))
      yield* changed(
        tombstonePrefix + encodeURIComponent(id),
        AccountState.fields.revoked.value,
        JSON.stringify(before.revoked[id]) ?? "",
        tombstone,
      );

    for (const id of Object.keys(before.revoked))
      if (!Object.hasOwn(after.revoked, id))
        yield* storage.delete(tombstonePrefix + encodeURIComponent(id));
  });

  const authority = Effect.fnUntraced(function* () {
    const raw = yield* storage.get(sharedKey);

    if (raw !== undefined)
      return yield* Schema.decodeUnknownEffect(SharedAccount, {
        onExcessProperty: "error",
      })(raw).pipe(Effect.orDie);

    for (const prefix of [
      channelPrefix,
      tombstonePrefix,
      oauthKey,
      attemptsKey,
      enrollmentsKey,
    ])
      if ((yield* storage.list({ prefix })).size !== 0)
        return yield* Effect.die("Incomplete keyed account storage");

    const { shared } = splitAccount(emptyState(""));
    yield* write(sharedKey, SharedAccount, shared);
    yield* write(oauthKey, AccountState.fields.oauth, []);
    yield* write(attemptsKey, AccountState.fields.attempts, {});
    yield* write(enrollmentsKey, AccountState.fields.enrollments, []);

    return shared;
  });

  const transact = <A>(
    f: (shared: SharedAccount) => Effect.Effect<A, never, RuntimeContext>,
  ) =>
    storage
      .transaction(
        Effect.gen(function* () {
          const shared = yield* authority();
          const before = JSON.stringify(shared);
          const result = yield* f(shared);
          yield* changed(sharedKey, SharedAccount, before, shared);
          yield* alarm(shared);

          return result;
        }),
      )
      .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie);

  const directory = Effect.fnUntraced(function* (shared: SharedAccount) {
    const channels = new Map<string, ChannelRecord>();
    const tombstones: [string, AccountState["revoked"][string]][] = [];

    const suffix = (key: string, prefix: string) => {
      const id = decodeURIComponent(key.slice(prefix.length));

      if (key !== prefix + encodeURIComponent(id))
        throw new Error("Noncanonical account record key");

      return id;
    };

    for (const [key, raw] of yield* storage.list({ prefix: channelPrefix }))
      channels.set(
        suffix(key, channelPrefix),
        yield* Schema.decodeUnknownEffect(ChannelRecord, {
          onExcessProperty: "error",
        })(raw).pipe(Effect.orDie),
      );

    for (const [key, raw] of yield* storage.list({ prefix: tombstonePrefix }))
      tombstones.push([
        suffix(key, tombstonePrefix),
        yield* Schema.decodeUnknownEffect(AccountState.fields.revoked.value, {
          onExcessProperty: "error",
        })(raw).pipe(Effect.orDie),
      ]);

    return {
      shared,
      channels,
      revoked: Object.fromEntries(tombstones),
      oauth: yield* read(oauthKey, AccountState.fields.oauth),
      attempts: yield* read(attemptsKey, AccountState.fields.attempts),
      enrollments: yield* read(enrollmentsKey, AccountState.fields.enrollments),
    };
  });

  const withAttempt = <A>(
    shared: SharedAccount,
    f: (
      state: SharedAccount & Pick<AccountState, "attempts">,
    ) => Effect.Effect<A, never, RuntimeContext>,
  ) =>
    Effect.gen(function* () {
      const attempts = yield* read(attemptsKey, AccountState.fields.attempts);
      const before = JSON.stringify(attempts);
      const state = { ...shared, attempts };
      const result = yield* f(state);
      const { attempts: after, ...updated } = state;
      Object.assign(shared, updated);
      yield* changed(attemptsKey, AccountState.fields.attempts, before, after);

      return result;
    });

  return AccountStore.of({
    shared: (f) => transact((shared) => Effect.sync(() => f(shared))),
    sendAttempt: (f) =>
      transact((shared) =>
        withAttempt(shared, (state) => Effect.sync(() => f(state))),
      ),
    channelDispatch: (id, f) =>
      transact((shared) =>
        withAttempt(
          shared,
          Effect.fnUntraced(function* (state) {
            const raw = yield* storage.get(
              channelPrefix + encodeURIComponent(id),
            );

            const record =
              raw === undefined
                ? null
                : yield* Schema.decodeUnknownEffect(ChannelRecord, {
                    onExcessProperty: "error",
                  })(raw).pipe(Effect.orDie);

            if (
              record &&
              [...record.configured, ...record.public].some(
                (entry) => entry.member.id !== id,
              )
            )
              return yield* Effect.die("Conflicting channel membership key");
            const subscription = record?.subscription;

            const tombstoneKey = subscription
              ? tombstonePrefix + encodeURIComponent(subscription.id)
              : null;

            const tombstoneRaw =
              tombstoneKey === null
                ? undefined
                : yield* storage.get(tombstoneKey);

            const tombstone =
              tombstoneRaw === undefined
                ? null
                : yield* Schema.decodeUnknownEffect(
                    AccountState.fields.revoked.value,
                    { onExcessProperty: "error" },
                  )(tombstoneRaw).pipe(Effect.orDie);

            const slice: ChannelDispatchState = {
              ...state,
              channels: record?.configured.map((entry) => entry.member) ?? [],
              publicMembers: record?.public.map((entry) => entry.member) ?? [],
              subscriptions: subscription ? { [id]: subscription } : {},
              revoked:
                subscription && tombstone
                  ? { [subscription.id]: tombstone }
                  : {},
            };

            const result = f(slice);

            const {
              channels: _channels,
              publicMembers: _public,
              subscriptions: _subscriptions,
              revoked,
              ...updated
            } = slice;

            Object.assign(state, updated);

            if (
              subscription &&
              tombstone &&
              !revoked[subscription.id] &&
              tombstoneKey !== null
            )
              yield* storage.delete(tombstoneKey);

            return result;
          }),
        ),
      ),
    update: (f) =>
      transact(
        Effect.fnUntraced(function* (shared) {
          const before = yield* directory(shared);

          const state = yield* Schema.decodeUnknownEffect(AccountState)(
            yield* joinDirectory(before).pipe(Effect.orDie),
          ).pipe(Effect.orDie);

          const result = f(state);
          yield* Schema.encodeEffect(AccountState)(state).pipe(Effect.orDie);
          const after = splitAccount(state);
          yield* persistDirectory(after, before);
          Object.assign(shared, after.shared);

          return result;
        }),
      ),
  });
});

export const makeAccountRpc = Effect.fnUntraced(function* (
  config: Parameters<typeof accountServiceLayer>[0],
  provider: typeof TwitchProvider.Service,
) {
  const { storage } = yield* Cloudflare.DurableObjectState;
  const accountStore = yield* makeAccountStorage(storage);

  const account = yield* AccountService.pipe(
    Effect.provide(accountServiceLayer(config)),
  ).pipe(
    Effect.provideService(AccountStore, accountStore),
    Effect.provideService(TwitchProvider, provider),
  );

  const reply = Effect.fnUntraced(function* <A, I>(
    effect: Effect.Effect<A, AccountError>,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* effect.pipe(
      Effect.flatMap(Schema.encodeEffect(schema)),
      Effect.map((value) => ({ kind: "success", value }) as const),
      Effect.catchTags({
        AccountError: (error) =>
          Effect.succeed({ kind: "failure", code: error.code } as const),
        SchemaError: () =>
          Effect.succeed({ kind: "failure", code: "input" } as const),
      }),
    );
  });

  return {
    dispatch: (input: Parameters<typeof account.service.dispatch>[0]) =>
      reply(account.service.dispatch(input), DispatchOutcome),
    setup: (operator: string) =>
      reply(account.service.setup(operator), SetupResult),
    completeOAuth: (
      input: Parameters<typeof account.service.completeOAuth>[0],
    ) => reply(account.service.completeOAuth(input), AccountStatus),
    status: () => reply(account.service.status(), AccountStatus),
    observeSubscription: (
      input: Parameters<typeof account.service.observeSubscription>[0],
    ) =>
      reply(
        account.service.observeSubscription(input).pipe(Effect.as(null)),
        Schema.Null,
      ),
    beginEnrollment: (input: Parameters<typeof account.enrollment.begin>[0]) =>
      reply(account.enrollment.begin(input), Schema.String),
    completeEnrollment: (
      input: Parameters<typeof account.enrollment.complete>[0],
    ) => reply(account.enrollment.complete(input), EnrollmentStatus),
    enrollmentStatus: (
      session: Parameters<typeof account.enrollment.status>[0],
    ) => reply(account.enrollment.status(session), EnrollmentStatus),
    alarm: account.credentialAlarm,
  };
});

export class AccountEndpoints extends Context.Service<
  AccountEndpoints,
  {
    readonly resolve: Effect.Effect<
      { readonly api: string; readonly oauth: string },
      never,
      RuntimeContext
    >;
  }
>()("@arctools/AccountEndpoints") {}

export interface AccountRuntimeConfig {
  readonly identity: AccountIdentity;
  readonly revision: string;
  readonly webhookOrigin: string;
  readonly oauthOrigin: string;
  readonly webhookReady: boolean;
  readonly twitchClientSecret: Redacted.Redacted<string>;
  readonly twitchSigningSecret: Redacted.Redacted<string>;
}

export const makeAccountRuntime = Effect.fnUntraced(function* (
  config: AccountRuntimeConfig,
  endpoints?: typeof AccountEndpoints.Service.resolve,
) {
  const callback = `${config.webhookOrigin}/webhooks/twitch`;
  const redirect = `${config.oauthOrigin}/oauth/twitch/callback`;

  const binding = yield* subscriptionBinding({
    callback,
    clientId: config.identity.twitchClientId,
    signingSecret: config.twitchSigningSecret,
  });

  return yield* makeAccountRpc(
    {
      ...config,
      callback,
      redirect,
      subscriptionBinding: binding,
    },
    yield* TwitchProvider.pipe(
      Effect.provide(
        providerLayer(
          {
            clientId: config.identity.twitchClientId,
            clientSecret: config.twitchClientSecret,
            signingSecret: config.twitchSigningSecret,
            callback,
            redirect,
          },
          endpoints === undefined ? undefined : yield* endpoints,
        ).pipe(Layer.provide(providerTransport)),
      ),
    ),
  );
});

type AccountStub = {
  readonly [K in keyof typeof TwitchAccount.Service]: (
    ...args: Parameters<(typeof AccountRpc.Service)[K]>
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
};

const makeReplyDecoder = Effect.fnUntraced(function* () {
  const runtime = yield* RuntimeContext;

  const decode = Effect.fnUntraced(function* <A, I, E>(
    effect: Effect.Effect<unknown, E, RuntimeContext>,
    schema: Schema.Codec<A, I>,
  ) {
    const raw = yield* effect.pipe(
      Effect.provideService(RuntimeContext, runtime),
      Effect.mapError(() => new AccountError({ code: "provider" })),
    );

    const response = yield* Schema.decodeUnknownEffect(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("success"), value: schema }),
        Schema.Struct({
          kind: Schema.Literal("failure"),
          code: AccountError.fields.code,
        }),
      ]),
    )(raw).pipe(Effect.mapError(() => new AccountError({ code: "provider" })));

    if (response.kind === "failure")
      return yield* new AccountError({ code: response.code });

    return response.value;
  });

  return decode;
});

export const makeAccountClient = Effect.fnUntraced(function* (
  object: AccountStub,
) {
  const decode = yield* makeReplyDecoder();

  return TwitchAccount.of({
    dispatch: (input) => decode(object.dispatch(input), DispatchOutcome),
    setup: (operator) => decode(object.setup(operator), SetupResult),
    status: () => decode(object.status(), AccountStatus),
    completeOAuth: (input) =>
      decode(object.completeOAuth(input), AccountStatus),
    observeSubscription: (input) =>
      decode(object.observeSubscription(input), Schema.Null).pipe(
        Effect.asVoid,
      ),
  });
});

type EnrollmentStub = {
  readonly [
    K in "beginEnrollment" | "completeEnrollment" | "enrollmentStatus"
  ]: (
    ...args: Parameters<(typeof AccountRpc.Service)[K]>
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
};

export const makeEnrollmentClient = Effect.fnUntraced(function* (
  object: EnrollmentStub,
) {
  const decode = yield* makeReplyDecoder();

  return TwitchEnrollment.of({
    begin: (input) => decode(object.beginEnrollment(input), Schema.String),
    complete: (input) =>
      decode(object.completeEnrollment(input), EnrollmentStatus),
    status: (session) =>
      decode(object.enrollmentStatus(session), EnrollmentStatus),
  });
});

export class AccountRpc extends Context.Service<
  AccountRpc,
  Effect.Success<ReturnType<typeof makeAccountRpc>>
>()("@arctools/AccountRpc") {}

export const accountRpcLayer = (
  config: Parameters<typeof makeAccountRpc>[0],
  provider: typeof TwitchProvider.Service,
) => Layer.effect(AccountRpc, makeAccountRpc(config, provider));

export const accountStorageLayer = (storage: AccountStorage) =>
  Layer.effect(AccountStore, makeAccountStorage(storage));
