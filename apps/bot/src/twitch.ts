import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  makeAccountClient,
  makeAccountRuntime,
  makeEnrollmentClient,
  AccountEndpoints,
  type AccountRuntimeConfig,
} from "@arctools/twitch/cloudflare";
import { TwitchAccount } from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import {
  Effect,
  Layer,
  Option,
  Redacted,
  Schema as EffectSchema,
} from "effect";

import { bindBotOrigin, oauthOrigin, runtimeConfig } from "./config.js";

export class TwitchAccountDO extends Cloudflare.DurableObject<TwitchAccountDO>()(
  "TwitchAccount",
  Effect.gen(function* () {
    const configuration = yield* runtimeConfig.pipe(Effect.orDie);
    const origin = yield* bindBotOrigin.pipe(Effect.orDie);
    const configuredOAuthOrigin = yield* oauthOrigin.pipe(Effect.orDie);
    const endpoints = yield* Effect.serviceOption(AccountEndpoints);

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
    return Effect.gen(function* () {
      const webhookOrigin = yield* origin;
      const oauthOrigin = configuredOAuthOrigin ?? webhookOrigin;
      const webhookReady = true;

      const revision = yield* accountRevision({
        ...configuration,
        webhookOrigin,
        oauthOrigin,
        webhookReady,
      });

      return yield* makeAccountRuntime(
        {
          ...configuration,
          webhookOrigin,
          oauthOrigin,
          webhookReady,
          revision,
        },
        Option.isSome(endpoints) ? endpoints.value.resolve : undefined,
      );
    });
  }),
) {}

export const bindAccount = Effect.gen(function* () {
  const objects = yield* TwitchAccountDO;

  // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
  return Effect.gen(function* () {
    const object = objects.getByName("environment");

    return yield* makeAccountClient(object);
  });
});

export const makeClient = bindAccount.pipe(Effect.flatten);

export const layer = Layer.effect(TwitchAccount, makeClient);

export const bindEnrollment = Effect.gen(function* () {
  const objects = yield* TwitchAccountDO;

  // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
  return Effect.suspend(() =>
    makeEnrollmentClient(objects.getByName("environment")),
  );
});

export const accountRevision = Effect.fnUntraced(function* (
  config: Omit<AccountRuntimeConfig, "revision">,
) {
  return yield* digest(
    yield* EffectSchema.encodeEffect(
      EffectSchema.fromJsonString(EffectSchema.Unknown),
    )([
      config.identity,
      config.webhookOrigin,
      config.oauthOrigin,
      config.webhookReady,
      Redacted.value(config.twitchClientSecret),
      Redacted.value(config.twitchSigningSecret),
    ]).pipe(Effect.orDie),
  );
});
