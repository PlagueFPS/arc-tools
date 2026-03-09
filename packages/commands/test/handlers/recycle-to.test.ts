import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { recycleToHandler } from "../../src/handlers/recycle-to.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(recycleToHandler);

describe("recycleToHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!recycleto sensors')",
      );
    }),
  );

  it.effect("returns no such item when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      assert.strictEqual(result, "[Warn] No such item: missing");
    }),
  );

  it.effect("returns recycle data not found when recycle_from missing", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_from: null })],
      })("item");
      assert.strictEqual(result, "[Warn] recycle data not found for Item");
    }),
  );

  it.effect("returns no items recycle to when empty", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ recycle_from: [] })],
      })("item");
      assert.strictEqual(result, "No items recycle to Item");
    }),
  );

  it.effect("formats recycle_from sorted by quantity desc", () =>
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
      assert.strictEqual(result, "These items recycle to Item: Metal (x5), Scrap (x2)");
    }),
  );
});
