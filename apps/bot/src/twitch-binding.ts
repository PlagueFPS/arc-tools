import { Effect, Redacted } from "effect";

import { digest } from "./provider-http.js";

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
