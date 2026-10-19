import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { recycleHandler } from "../../src/handlers/recycle.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(recycleHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("recycleHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!recycle sensors')");
    }),
  );

  test(
    "returns no such item when unresolved",
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      expect(result).toBe("[Warn] No such item: missing");
    }),
  );

  test(
    "returns recycle data not found when missing",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_components: null })],
      })("item");
      expect(result).toBe("[Warn] recycle data not found for Item");
    }),
  );

  test(
    "returns no items granted when empty",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_components: [] })],
      })("item");
      expect(result).toBe("No items granted for recycling Item");
    }),
  );

  test(
    "formats recycle components sorted by quantity desc",
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            recycle_components: [
              { quantity: 1, component: { id: "a", name: "A" } },
              { quantity: 3, component: { id: "b", name: "B" } },
              { quantity: 2, component: { id: "c", name: "C" } },
            ],
          }),
        ],
      })("item");
      expect(result).toBe(
        "These items are granted for recycling Item: B (x3), C (x2), A (x1)",
      );
    }),
  );
});
