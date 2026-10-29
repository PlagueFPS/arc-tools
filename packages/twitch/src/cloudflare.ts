import * as Cloudflare from "@alchemy.run/cloudflare";
import { providerTransport } from "@arctools/utils/http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Context,
  HashMap,
  Effect,
  Layer,
  Redacted,
  Schema,
  Array as Arr,
  Record as Rec,
  String as Str,
  Option,
} from "effect";

import {
  AccountService,
  accountServiceLayer,
  type AccountIdentity,
} from "./account.js";
import { subscriptionBinding } from "./binding.js";
import {
  AccountError,
  SubscriptionAdmission,
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
  nextCleanup,
  policy,
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
  ) => Effect.Effect<
    A,
    Cloudflare.DurableObjectStorageError,
    R | RuntimeContext
  >;
};

const sharedKey = "account:shared:v1";

const channelPrefix = "account:channel:v1/";

const tombstonePrefix = "account:tombstone:v1/";

const oauthKey = "account:oauth:v1";

const attemptsKey = "account:attempts:v1";

const enrollmentsKey = "account:enrollments:v1";

const leftPrefix = "account:left:v1/";

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
      new TextEncoder().encode(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          encoded,
        ).pipe(Effect.orDie),
      ).byteLength >
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
    const normalized = yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.orDie,
    );

    if (
      before !==
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        normalized,
      ).pipe(Effect.orDie))
    )
      yield* write(key, schema, normalized);
  });

  const alarm = Effect.fnUntraced(function* (shared: SharedAccount) {
    const due = Option.getOrNull(nextAlarm(shared));

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
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        before.oauth,
      ).pipe(Effect.orDie),
      after.oauth,
    );
    yield* changed(
      attemptsKey,
      AccountState.fields.attempts,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        before.attempts,
      ).pipe(Effect.orDie),
      after.attempts,
    );
    yield* changed(
      enrollmentsKey,
      AccountState.fields.enrollments,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* read(enrollmentsKey, AccountState.fields.enrollments),
      ).pipe(Effect.orDie),
      Arr.filter(after.enrollments, (entry) => !!(entry.phase.kind !== "left")),
    );

    const beforeLeft = HashMap.fromIterable(
      Arr.map(
        Arr.filter(
          before.enrollments,
          (entry) => !!(entry.phase.kind === "left"),
        ),
        (entry) => [entry.session, entry],
      ),
    );

    const afterLeft = HashMap.fromIterable(
      Arr.map(
        Arr.filter(
          after.enrollments,
          (entry) => !!(entry.phase.kind === "left"),
        ),
        (entry) => [entry.session, entry],
      ),
    );

    for (const [session, entry] of afterLeft)
      yield* changed(
        leftPrefix + session,
        AccountState.fields.enrollments.value,
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          (yield* storage.get(leftPrefix + session)) ?? null,
        ).pipe(Effect.orDie)) ?? "",
        entry,
      );

    for (const session of HashMap.keys(beforeLeft))
      if (!HashMap.has(afterLeft, session))
        yield* storage.delete(leftPrefix + session);

    for (const [id, record] of after.channels)
      yield* changed(
        channelPrefix + encodeURIComponent(id),
        ChannelRecord,
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          before.channels.get(id) ?? null,
        ).pipe(Effect.orDie)) ?? "",
        record,
      );

    for (const id of before.channels.keys())
      if (!after.channels.has(id))
        yield* storage.delete(channelPrefix + encodeURIComponent(id));

    for (const [id, tombstone] of Rec.toEntries(after.revoked))
      yield* changed(
        tombstonePrefix + encodeURIComponent(id),
        AccountState.fields.revoked.value,
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          before.revoked[id] ?? null,
        ).pipe(Effect.orDie)) ?? "",
        tombstone,
      );

    for (const id of Rec.keys(before.revoked))
      if (!Rec.has(after.revoked, id))
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
      leftPrefix,
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

          const before = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(shared).pipe(Effect.orDie);

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
      const id = decodeURIComponent(Str.slice(prefix.length)(key));

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
      revoked: Rec.fromEntries(tombstones),
      oauth: yield* read(oauthKey, AccountState.fields.oauth),
      attempts: yield* read(attemptsKey, AccountState.fields.attempts),
      enrollments: [
        ...(yield* read(enrollmentsKey, AccountState.fields.enrollments)),
        ...(yield* Effect.forEach(
          yield* storage.list({ prefix: leftPrefix }),
          ([key, value]) =>
            Schema.decodeUnknownEffect(AccountState.fields.enrollments.value)(
              value,
            ).pipe(
              Effect.orDie,
              Effect.tap((entry) =>
                key === leftPrefix + entry.session &&
                entry.phase.kind === "left"
                  ? Effect.void
                  : Effect.die("Invalid left replay key"),
              ),
            ),
        )),
      ],
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

      const before = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(attempts).pipe(Effect.orDie);

      const state = { ...shared, attempts };
      const result = yield* f(state);
      state.nextCleanupAt = Math.min(
        state.nextCleanupAt ?? Infinity,
        ...Arr.map(Rec.values(state.attempts), (entry) => entry.retainUntil),
        ...Arr.map(
          state.reservations,
          (entry) => entry.at + policy.globalWindowMs,
        ),
      );

      if (!Number.isFinite(state.nextCleanupAt)) state.nextCleanupAt = null;
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
              Arr.some(
                [...record.configured, ...record.public],
                (entry) => !!(entry.member.id !== id),
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
              channels:
                Option.getOrUndefined(
                  Option.map(
                    Option.fromNullishOr(record?.configured),
                    (effectNativeValue0) =>
                      Arr.map(effectNativeValue0, (entry) => entry.member),
                  ),
                ) ?? [],
              publicMembers:
                Option.getOrUndefined(
                  Option.map(
                    Option.fromNullishOr(record?.public),
                    (effectNativeValue1) =>
                      Arr.map(effectNativeValue1, (entry) => entry.member),
                  ),
                ) ?? [],
              lifecycle: record?.lifecycle ? { [id]: record.lifecycle } : {},
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
              lifecycle: _lifecycle,
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

          const state: AccountState = yield* Schema.decodeEffect(AccountState)(
            yield* joinDirectory(before).pipe(Effect.orDie),
          ).pipe(Effect.orDie);

          const result = f(state);
          state.nextCleanupAt = Option.getOrNull(nextCleanup(state));

          const recoveryDue = Math.min(
            ...Arr.map(Rec.values(state.lifecycle), (value) =>
              value.kind === "installed"
                ? (value.recovery?.due ?? Infinity)
                : Infinity,
            ),
          );

          state.nextRecoveryAt = Number.isFinite(recoveryDue)
            ? recoveryDue
            : null;
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
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
    Effect.provide(accountServiceLayer(config)),
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
    status: () => reply(account.service.status, AccountStatus),
    observeSubscription: (
      input: Parameters<typeof account.service.observeSubscription>[0],
    ) =>
      reply(account.service.observeSubscription(input), SubscriptionAdmission),
    beginEnrollment: (input: Parameters<typeof account.enrollment.begin>[0]) =>
      reply(account.enrollment.begin(input), Schema.String),
    completeEnrollment: (
      input: Parameters<typeof account.enrollment.complete>[0],
    ) => reply(account.enrollment.complete(input), EnrollmentStatus),
    leaveEnrollment: (
      session: Parameters<typeof account.enrollment.leave>[0],
    ) => reply(account.enrollment.leave(session), EnrollmentStatus),
    enrollmentStatus: (
      session: Parameters<typeof account.enrollment.status>[0],
    ) => reply(account.enrollment.status(session), EnrollmentStatus),
    alarm: () => account.credentialAlarm,
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
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

type AccountStub<E> = {
  readonly [K in keyof typeof TwitchAccount.Service]: (
    ...args: Parameters<(typeof AccountRpc.Service)[K]>
  ) => Effect.Effect<unknown, E, RuntimeContext>;
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

export const makeAccountClient = Effect.fnUntraced(function* <E>(
  object: AccountStub<E>,
) {
  const decode = yield* makeReplyDecoder();

  return TwitchAccount.of({
    dispatch: (input) => decode(object.dispatch(input), DispatchOutcome),
    setup: (operator) => decode(object.setup(operator), SetupResult),
    status: decode(object.status(), AccountStatus),
    completeOAuth: (input) =>
      decode(object.completeOAuth(input), AccountStatus),
    observeSubscription: (input) =>
      decode(object.observeSubscription(input), SubscriptionAdmission),
  });
});

type EnrollmentStub<E> = {
  readonly [
    K in
      | "beginEnrollment"
      | "completeEnrollment"
      | "enrollmentStatus"
      | "leaveEnrollment"
  ]: (
    ...args: Parameters<(typeof AccountRpc.Service)[K]>
  ) => Effect.Effect<unknown, E, RuntimeContext>;
};

export const makeEnrollmentClient = Effect.fnUntraced(function* <E>(
  object: EnrollmentStub<E>,
) {
  const decode = yield* makeReplyDecoder();

  return TwitchEnrollment.of({
    leave: (session) =>
      decode(object.leaveEnrollment(session), EnrollmentStatus),
    begin: (input) => decode(object.beginEnrollment(input), Schema.String),
    complete: (input) =>
      decode(object.completeEnrollment(input), EnrollmentStatus),
    status: (session) =>
      decode(object.enrollmentStatus(session), EnrollmentStatus),
  });
});

// oxlint-disable-next-line effecttsgo/lazy-effect -- Alchemy RPC serialization requires callable status and alarm methods.
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
