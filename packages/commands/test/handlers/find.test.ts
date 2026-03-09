import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { findHandler } from "../../src/handlers/find.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(findHandler);

describe("findHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!find sensors')",
      );
    }),
  );

  it.effect("returns no such item when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      assert.strictEqual(result, "[Warn] No such item: missing");
    }),
  );

  it.effect("only loot_area present", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: "Cargo Bay" })],
      })("item");
      assert.strictEqual(result, "Item can be found in Cargo Bay areas.");
    }),
  );

  it.effect("only dropped_by present", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            dropped_by: [
              { arc: { id: "a1", name: "Arc One" } },
              { arc: { id: "a2", name: "Arc Two" } },
            ],
          }),
        ],
      })("item");
      assert.strictEqual(result, "Item can be dropped by Arc One, Arc Two.");
    }),
  );

  it.effect("both loot_area and dropped_by", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            loot_area: "Cargo",
            dropped_by: [{ arc: { id: "a", name: "Bastion" } }],
          }),
        ],
      })("item");
      assert.strictEqual(
        result,
        "Item can be found in Cargo areas and can be dropped by Bastion.",
      );
    }),
  );

  it.effect("neither present returns warn", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: null, dropped_by: null })],
      })("item");
      assert.strictEqual(
        result,
        "[Warn] loot area or dropped by data not found for Item",
      );
    }),
  );

  it.effect("empty dropped_by array treated as neither", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: null, dropped_by: [] })],
      })("item");
      assert.strictEqual(
        result,
        "[Warn] loot area or dropped by data not found for Item",
      );
    }),
  );
});
