import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { findHandler } from "../../src/handlers/find.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(findHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("findHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!find sensors')");
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
    "only loot_area present",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: "Cargo Bay" })],
      })("item");
      expect(result).toBe("Item can be found in Cargo Bay areas.");
    }),
  );

  test(
    "only dropped_by present",
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
      expect(result).toBe("Item can be dropped by Arc One, Arc Two.");
    }),
  );

  test(
    "both loot_area and dropped_by",
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            loot_area: "Cargo",
            dropped_by: [{ arc: { id: "a", name: "Bastion" } }],
          }),
        ],
      })("item");
      expect(result).toBe(
        "Item can be found in Cargo areas and can be dropped by Bastion.",
      );
    }),
  );

  test(
    "neither present returns warn",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: null, dropped_by: null })],
      })("item");
      expect(result).toBe(
        "[Warn] loot area or dropped by data not found for Item",
      );
    }),
  );

  test(
    "empty dropped_by array treated as neither",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ loot_area: null, dropped_by: [] })],
      })("item");
      expect(result).toBe(
        "[Warn] loot area or dropped by data not found for Item",
      );
    }),
  );
});
