import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { lootHandler } from "../../src/handlers/loot.js";
import { arc } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(lootHandler);

describe("lootHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an arc name (e.g. '!loot bastion')",
      );
    }),
  );

  it.effect("returns no such arc when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      assert.strictEqual(result, "[Warn] No such arc: missing");
    }),
  );

  it.effect("slug hit returns loot", () =>
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [
          arc({ id: "bastion", loot: [{ item: { id: "a", name: "A" } }] }),
        ],
      })("bastion");
      assert.strictEqual(result, "Bastions drop the following items: A");
    }),
  );

  it.effect("normalized search fallback works", () =>
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [
          arc({
            id: "three-word-name",
            name: "Three Word Arc",
            loot: [{ item: { id: "loot-item", name: "Loot Item" } }],
          }),
        ],
      })("three word arc");
      assert.strictEqual(
        result,
        "Three Word Arcs drop the following items: Loot Item",
      );
    }),
  );

  it.effect("returns loot data not found when loot field missing", () =>
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [arc({ loot: null })],
      })("bastion");
      assert.strictEqual(result, "[Warn] loot data not found for Bastion");
    }),
  );

  it.effect("returns no loot found when loot empty", () =>
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [arc({ loot: [] })],
      })("bastion");
      assert.strictEqual(result, "No loot found for Bastion");
    }),
  );

  it.effect("formats multiple loot items", () =>
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [
          arc({
            loot: [
              { item: { id: "a", name: "A" } },
              { item: { id: "b", name: "B" } },
            ],
          }),
        ],
      })("bastion");
      assert.strictEqual(result, "Bastions drop the following items: A, B");
    }),
  );
});
