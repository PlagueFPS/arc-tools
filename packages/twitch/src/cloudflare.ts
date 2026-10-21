import { providerTransport } from "@arctools/utils/http";
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect";

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
import { AccountState, AccountStore, emptyState, nextAlarm } from "./state.js";

type NativeStorage = Cloudflare.DurableObjectState["Service"]["storage"];

export type AccountStorage = Pick<
  NativeStorage,
  "getAlarm" | "setAlarm" | "deleteAlarm"
> & {
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>;
  readonly put: (
    key: string,
    value: typeof AccountState.Encoded,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly transaction: <A, R>(
    effect: Effect.Effect<A, never, R>,
  ) => Effect.Effect<A, unknown, R | RuntimeContext>;
};

export const makeAccountStorage = Effect.fnUntraced(function* (
  storage: AccountStorage,
) {
  const runtime = yield* RuntimeContext;

  const provide = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
    effect.pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie);

  return AccountStore.of({
    update: (f) =>
      provide(
        storage.transaction(
          Effect.gen(function* () {
            const raw = yield* storage.get("account:v1");

            const state: AccountState = Predicate.isUndefined(raw)
              ? emptyState("")
              : yield* Schema.decodeUnknownEffect(AccountState)(raw).pipe(
                  Effect.orDie,
                );

            const result = f(state);

            const encoded = yield* Schema.encodeEffect(AccountState)(
              state,
            ).pipe(Effect.orDie);

            if (
              new TextEncoder().encode(JSON.stringify(encoded)).byteLength >
              120 * 1024
            )
              return yield* Effect.die("Account storage capacity exceeded");
            yield* storage.put("account:v1", encoded);

            const alarm = nextAlarm(state);

            if ((yield* storage.getAlarm()) !== alarm)
              yield* Predicate.isNull(alarm)
                ? storage.deleteAlarm()
                : storage.setAlarm(alarm);

            return result;
          }),
        ),
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
  readonly publicUrl: string;
  readonly webhookReady: boolean;
  readonly twitchClientSecret: Redacted.Redacted<string>;
  readonly twitchSigningSecret: Redacted.Redacted<string>;
}

export const makeAccountRuntime = Effect.fnUntraced(function* (
  config: AccountRuntimeConfig,
  endpoints?: typeof AccountEndpoints.Service.resolve,
) {
  const callback = `${config.publicUrl}/webhooks/twitch`;
  const redirect = `${config.publicUrl}/oauth/twitch/callback`;

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
