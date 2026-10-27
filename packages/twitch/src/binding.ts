import { digest } from "@arctools/utils/http";
import { Effect, Redacted, Schema as EffectSchema } from "effect";

export const subscriptionBinding = Effect.fnUntraced(function* (config: {
  readonly callback: string;
  readonly clientId: string;
  readonly signingSecret: Redacted.Redacted<string>;
}) {
  return yield* digest(
    yield* EffectSchema.encodeEffect(
      EffectSchema.fromJsonString(EffectSchema.Unknown),
    )([
      config.callback,
      config.clientId,
      Redacted.value(config.signingSecret),
    ]).pipe(Effect.orDie),
  );
});
