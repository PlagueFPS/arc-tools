import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { craftHandler } from "../../src/handlers/craft.js";
import { item } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(craftHandler);

describe("craftHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!craft sensors')",
      );
    }),
  );

  it.effect("returns no such item when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("missing");
      assert.strictEqual(result, "[Warn] No such item: missing");
    }),
  );

  it.effect("returns cannot be crafted when workbench missing", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ workbench: null, components: null })],
      })("item");
      assert.strictEqual(result, "Item cannot be crafted.");
    }),
  );

  it.effect("returns cannot be crafted when components missing", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [item({ workbench: "Basic", components: null })],
      })("item");
      assert.strictEqual(result, "Item cannot be crafted.");
    }),
  );

  it.effect("formats components on success", () =>
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
      assert.include(result, "Refiner");
      assert.include(result, "Component X (x2)");
      assert.include(result, "Component Y (x1)");
    }),
  );
});
