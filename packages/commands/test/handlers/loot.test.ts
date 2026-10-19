import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";

import { lootHandler } from "../../src/handlers/loot.js";
import { arc } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(lootHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("lootHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an arc name (e.g. '!loot bastion')");
    }),
  );

  test(
    "returns no such arc when unresolved",
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      expect(result).toBe("[Warn] No such arc: missing");
    }),
  );

  test(
    "slug hit returns loot",
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [
          arc({ id: "bastion", loot: [{ item: { id: "a", name: "A" } }] }),
        ],
      })("bastion");
      expect(result).toBe("Bastions drop the following items: A");
    }),
  );

  test(
    "normalized search fallback works",
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
      expect(result).toBe(
        "Three Word Arcs drop the following items: Loot Item",
      );
    }),
  );

  test(
    "returns loot data not found when loot field missing",
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [arc({ loot: null })],
      })("bastion");
      expect(result).toBe("[Warn] loot data not found for Bastion");
    }),
  );

  test(
    "returns no loot found when loot empty",
    Effect.gen(function* () {
      const result = yield* run({
        arcs: [arc({ loot: [] })],
      })("bastion");
      expect(result).toBe("No loot found for Bastion");
    }),
  );

  test(
    "formats multiple loot items",
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
      expect(result).toBe("Bastions drop the following items: A, B");
    }),
  );
});
