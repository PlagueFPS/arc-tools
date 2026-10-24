import * as Cloudflare from "@alchemy.run/cloudflare";
import { Cause, Effect, Exit } from "effect";
import { HttpServerResponse } from "effect/http";

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
    return yield* Effect.fail(
      new Error("Reconstruction RPC returned without aborting"),
    );
  const error = Cause.squash(result.cause);

  if (
    !(
      error instanceof Cloudflare.RpcCallError &&
      error.cause instanceof Error &&
      error.cause.message === reason
    )
  )
    return yield* Effect.failCause(result.cause);

  return HttpServerResponse.empty({ status: 204 });
}, Effect.orDie);
