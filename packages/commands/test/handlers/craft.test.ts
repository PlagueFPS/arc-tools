import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { craftHandler } from "../../src/handlers/craft.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(craftHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("craftHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!craft sensors')");
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
    "returns cannot be crafted when workbench missing",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ workbench: null })],
      })("item");
      expect(result).toBe("Item cannot be crafted.");
    }),
  );

  test(
    "returns cannot be crafted when components missing",
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ workbench: "Basic", components: null })],
      })("item");
      expect(result).toBe("Item cannot be crafted.");
    }),
  );

  test(
    "formats components on success",
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          item({
            workbench: "Refiner",
            components: [
              {
                quantity: 2,
                component: { id: "x", name: "Component X" },
              },
              {
                quantity: 1,
                component: { id: "y", name: "Component Y" },
              },
            ],
          }),
        ],
      })("item");
      expect(result).toContain("Refiner");
      expect(result).toContain("Component X (x2)");
      expect(result).toContain("Component Y (x1)");
    }),
  );
});
