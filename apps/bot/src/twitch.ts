import {
  makeAccountClient,
  makeAccountRuntime,
  makeEnrollmentClient,
  AccountEndpoints,
} from "@arctools/twitch/cloudflare";
import { TwitchAccount } from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Option, Redacted } from "effect";

import { bindOrigin, runtimeConfig } from "./config.js";

export class TwitchAccountDO extends Cloudflare.DurableObject<TwitchAccountDO>()(
  "TwitchAccount",
  Effect.gen(function* () {
    const configuration = yield* runtimeConfig.pipe(Effect.orDie);
    const origin = yield* bindOrigin.pipe(Effect.orDie);
    const endpoints = yield* Effect.serviceOption(AccountEndpoints);

    return Effect.gen(function* () {
      const publicUrl = yield* origin;
      const webhookReady = true;

      const revision = yield* digest(
        JSON.stringify([
          configuration.identity,
          publicUrl,
          webhookReady,
          Redacted.value(configuration.twitchClientSecret),
          Redacted.value(configuration.twitchSigningSecret),
        ]),
      );

      return yield* makeAccountRuntime(
        { ...configuration, publicUrl, webhookReady, revision },
        Option.isSome(endpoints) ? endpoints.value.resolve : undefined,
      );
    });
  }),
) {}

export const bindAccount = Effect.gen(function* () {
  const objects = yield* TwitchAccountDO;

  return Effect.gen(function* () {
    const object = objects.getByName("environment");

    return yield* makeAccountClient(object);
  });
});

export const makeClient = bindAccount.pipe(Effect.flatten);

export const layer = Layer.effect(TwitchAccount, makeClient);

export const bindEnrollment = Effect.gen(function* () {
  const objects = yield* TwitchAccountDO;

  return Effect.gen(function* () {
    return yield* makeEnrollmentClient(objects.getByName("environment"));
  });
});
