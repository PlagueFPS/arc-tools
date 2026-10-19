import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";

import { sellHandler } from "../../src/handlers/sell.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(sellHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("sellHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!sell sensors')");
    }),
  );

  test(
    "returns no such item when unresolved",
    Effect.gen(function* () {
      const result = yield* run({})("nonexistent");
      expect(result).toBe("[Warn] No such item: nonexistent");
    }),
  );

  test(
    "returns sell value on success",
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
      expect(result).toBe("Sensors can be sold for 25 coins each");
    }),
  );
});
