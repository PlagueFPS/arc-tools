import { Cause, Effect, Exit, Predicate } from "effect";
import { HttpServerResponse } from "effect/http";

import { FixtureInvariantError } from "./fixture-error.js";
import { fixtureHeader } from "./fixture-http.js";

export const identifyFixtureResponse = HttpServerResponse.setHeader(
  fixtureHeader,
  "v1",
);

export const acknowledgeReconstruction = Effect.fnUntraced(function* <A, E, R>(
  reset: Effect.Effect<A, E, R>,
  reason: string,
) {
  const result = yield* Effect.exit(reset);

  if (Exit.isSuccess(result))
    return yield* new FixtureInvariantError({
      message: "Reconstruction RPC returned without aborting",
    });
  const error = Cause.squash(result.cause);

  if (
    !(
      Predicate.isTagged(error, "RpcCallError") &&
      Predicate.hasProperty(error, "cause") &&
      Predicate.isError(error.cause) &&
      error.cause.message === reason
    )
  )
    return yield* Effect.failCause(result.cause);

  return HttpServerResponse.empty({ status: 204 });
}, Effect.orDie);
