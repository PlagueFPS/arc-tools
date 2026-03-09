import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { sellHandler } from "../../src/handlers/sell.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(sellHandler);

describe("sellHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!sell sensors')",
      );
    }),
  );

  it.effect("returns no such item when unresolved", () =>
    Effect.gen(function* () {
      const result = yield* run({})("nonexistent");
      assert.strictEqual(result, "[Warn] No such item: nonexistent");
    }),
  );

  it.effect("returns sell value on success", () =>
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          {
            id: "sensors",
            name: "Sensors",
            value: 25,
            workbench: null,
            loot_area: null,
            components: null,
            recycle_components: null,
            recycle_from: null,
            dropped_by: null,
          },
        ],
      })("sensors");
      assert.strictEqual(result, "Sensors can be sold for 25 coins each");
    }),
  );
});
