import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { buyHandler } from "../../src/handlers/buy.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(buyHandler);

describe("buyHandler", () => {
  it.effect("returns hint for empty query", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an item (e.g. '!buy sensors')",
      );
    }),
  );

  it.effect("returns no matches when traders empty", () =>
    Effect.gen(function* () {
      const result = yield* run({})("sensors");
      assert.strictEqual(result, "[Warn] No trader sells: sensors");
    }),
  );

  it.effect("returns match for exact id", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [],
          Celeste: [],
          Lance: [{ id: "power-cell", name: "Power Cell", trader_price: 50 }],
          Shani: [],
          TianWen: [],
        },
      })("power-cell");
      assert.strictEqual(
        result,
        "Power Cell can be purchased from Lance for 50 coins",
      );
    }),
  );

  it.effect("returns match for substring/name", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [],
          Celeste: [],
          Lance: [],
          Shani: [
            {
              id: "advanced-sensors",
              name: "Advanced Sensors",
              trader_price: 100,
            },
          ],
          TianWen: [],
        },
      })("sensors");
      assert.strictEqual(
        result,
        "Advanced Sensors can be purchased from Shani for 100 cred.",
      );
    }),
  );

  it.effect("Shani uses cred currency", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [],
          Celeste: [],
          Lance: [],
          Shani: [{ id: "x", name: "X", trader_price: 10 }],
          TianWen: [],
        },
      })("x");
      assert.match(result, /cred\./);
    }),
  );

  it.effect("Celeste uses seeds currency", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [],
          Celeste: [{ id: "y", name: "Y", trader_price: 20 }],
          Lance: [],
          Shani: [],
          TianWen: [],
        },
      })("y");
      assert.match(result, /seeds/);
    }),
  );

  it.effect("default traders use coins", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [{ id: "z", name: "Z", trader_price: 30 }],
          Celeste: [],
          Lance: [],
          Shani: [],
          TianWen: [],
        },
      })("z");
      assert.match(result, /coins/);
    }),
  );

  it.effect("formats multiple matches", () =>
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [{ id: "item", name: "Item", trader_price: 5 }],
          Celeste: [],
          Lance: [{ id: "item", name: "Item", trader_price: 6 }],
          Shani: [],
          TianWen: [],
        },
      })("item");
      assert.include(result, "Apollo");
      assert.include(result, "Lance");
      assert.include(result, "coins");
    }),
  );
});
