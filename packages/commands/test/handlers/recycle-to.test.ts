import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";

import { recycleToHandler } from "../../src/handlers/recycle-to.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(recycleToHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("recycleToHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!recycleto sensors')");
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
    "returns recycle data not found when recycle_from missing",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_from: null })],
      })("item");
      expect(result).toBe("[Warn] recycle data not found for Item");
    }),
  );

  test(
    "returns no items recycle to when empty",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_from: [] })],
      })("item");
      expect(result).toBe("No items recycle to Item");
    }),
  );

  test(
    "formats recycle_from sorted by quantity desc",
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            recycle_from: [
              { quantity: 2, item: { id: "x", name: "Scrap" } },
              { quantity: 5, item: { id: "y", name: "Metal" } },
            ],
          }),
        ],
      })("item");
      expect(result).toBe(
        "These items recycle to Item: Metal (x5), Scrap (x2)",
      );
    }),
  );
});
