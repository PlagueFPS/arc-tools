import { digest } from "@arctools/utils/http";
import { Effect, Redacted, Schema } from "effect";

export const subscriptionBinding = Effect.fnUntraced(function* (config: {
  readonly callback: string;
  readonly clientId: string;
  readonly signingSecret: Redacted.Redacted<string>;
}) {
  return yield* digest(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
      config.callback,
      config.clientId,
      Redacted.value(config.signingSecret),
    ]).pipe(Effect.orDie),
  );
});
