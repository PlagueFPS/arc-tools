import { digest } from "@arctools/utils/http";
import { Effect, Redacted } from "effect";

export const subscriptionBinding = Effect.fnUntraced(function* (config: {
  readonly callback: string;
  readonly clientId: string;
  readonly signingSecret: Redacted.Redacted<string>;
}) {
  return yield* digest(
    JSON.stringify([
      config.callback,
      config.clientId,
      Redacted.value(config.signingSecret),
    ]),
  );
});
