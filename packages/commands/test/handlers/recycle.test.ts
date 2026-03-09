import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { recycleHandler } from "../../src/handlers/recycle.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(recycleHandler);

describe("recycleHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!recycle sensors')",
      );
    }),
  );

  it.effect("returns no such item when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      assert.strictEqual(result, "[Warn] No such item: missing");
    }),
  );

  it.effect("returns recycle data not found when missing", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_components: null })],
      })("item");
      assert.strictEqual(result, "[Warn] recycle data not found for Item");
    }),
  );

  it.effect("returns no items granted when empty", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_components: [] })],
      })("item");
      assert.strictEqual(result, "No items granted for recycling Item");
    }),
  );

  it.effect("formats recycle components sorted by quantity desc", () =>
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
      assert.strictEqual(
        result,
        "These items are granted for recycling Item: B (x3), C (x2), A (x1)",
      );
    }),
  );
});
