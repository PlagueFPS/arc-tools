import { expect } from "bun:test";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "alchemy/Test/Bun";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { acknowledgeReconstruction } from "./fixture-response.js";

const { test } = Test.make({ providers: Layer.empty });

class ForeignRpcCallError extends Schema.TaggedError<
  ForeignRpcCallError,
  { readonly brand: unique symbol }
>()("RpcCallError", { cause: Schema.Unknown }) {}

const reason = "foundation reconstruction probe";

test(
  "only the requested native abort receives a 204 reconstruction acknowledgement",
  Effect.gen(function* () {
    const response = yield* acknowledgeReconstruction(
      new Cloudflare.RpcCallError({
        method: "reset",
        cause: new Error(reason),
      }),
      reason,
    );

    expect(response.status).toBe(204);

    const structural = yield* acknowledgeReconstruction(
      new ForeignRpcCallError({ cause: new Error(reason) }),
      reason,
    );

    expect(structural.status).toBe(204);

    const malformed = yield* Effect.exit(
      acknowledgeReconstruction(
        new ForeignRpcCallError({ cause: null }),
        reason,
      ),
    );

    expect(Exit.isFailure(malformed)).toBeTrue();

    for (const reset of [
      new Cloudflare.RpcCallError({
        method: "reset",
        cause: new Error("storage sync failed"),
      }),
      Effect.die(new Error("unexpected defect")),
      Effect.void,
    ]) {
      const result = yield* Effect.exit(
        acknowledgeReconstruction(reset, reason),
      );

      expect(Exit.isFailure(result)).toBeTrue();

      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).not.toContain("204");
    }
  }),
);
