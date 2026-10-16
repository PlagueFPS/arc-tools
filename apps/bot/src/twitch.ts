import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Redacted, Schema } from "effect";
import { accountRuntimeConfig } from "./config.js";
import { digest } from "./provider-http.js";
import { makeAccount } from "./twitch-account.js";
import { subscriptionBinding } from "./twitch-binding.js";
import {
  AccountError,
  AccountStatus,
  DispatchOutcome,
  SetupResult,
  TwitchAccount,
} from "./twitch-contracts.js";
import { makeProvider, TwitchProvider } from "./twitch-provider.js";
import { AccountState, AccountStore, emptyState } from "./twitch-state.js";

type NativeStorage = Cloudflare.DurableObjectState["Service"]["storage"];
export type AccountStorage = Pick<
  NativeStorage,
  "getAlarm" | "setAlarm" | "deleteAlarm"
> & {
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>;
  readonly put: (
    key: string,
    value: unknown,
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
            const state: AccountState =
              raw === undefined
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
            if ((yield* storage.getAlarm()) !== state.nextCredentialCheck)
              yield* state.nextCredentialCheck === null
                ? storage.deleteAlarm()
                : storage.setAlarm(state.nextCredentialCheck);
            return result;
          }),
        ),
      ),
  });
});
export const makeAccountRpc = Effect.fnUntraced(function* (
  config: Parameters<typeof makeAccount>[0],
  provider: typeof TwitchProvider.Service,
) {
  const { storage } = yield* Cloudflare.DurableObjectState;
  const accountStore = yield* makeAccountStorage(storage);
  const account = yield* makeAccount(config).pipe(
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
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failure",
          code: error instanceof AccountError ? error.code : "input",
        } as const),
      ),
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
    alarm: account.credentialAlarm,
  };
});
export class TwitchAccountDO extends Cloudflare.DurableObject<TwitchAccountDO>()(
  "TwitchAccount",
  Effect.gen(function* () {
    const config = yield* accountRuntimeConfig.pipe(Effect.orDie);
    return Effect.gen(function* () {
      const revision = yield* digest(
        JSON.stringify([
          config.identity,
          config.publicUrl,
          config.webhookReady,
          Redacted.value(config.twitchClientSecret),
          Redacted.value(config.twitchSigningSecret),
        ]),
      );
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
          revision,
          callback,
          redirect,
          subscriptionBinding: binding,
        },
        makeProvider({
          clientId: config.identity.twitchClientId,
          clientSecret: config.twitchClientSecret,
          signingSecret: config.twitchSigningSecret,
          callback,
          redirect,
        }),
      );
    });
  }),
) {}
export const bindAccount = Effect.gen(function* () {
  const objects = yield* TwitchAccountDO;
  return Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const object = objects.getByName("environment");
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
      )(raw).pipe(
        Effect.mapError(() => new AccountError({ code: "provider" })),
      );
      if (response.kind === "failure")
        return yield* new AccountError({ code: response.code });
      return response.value;
    });
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
});
export const makeClient = bindAccount.pipe(Effect.flatten);
export const layer = Layer.effect(TwitchAccount, makeClient);
