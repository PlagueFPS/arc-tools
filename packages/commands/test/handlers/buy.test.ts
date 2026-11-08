import { describe, expect } from "bun:test";

import * as Test from "@alchemy.run/test/Bun";
import { Effect, Layer } from "effect";

import { buyHandler } from "../../src/handlers/buy.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(buyHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("buyHandler", () => {
  test(
    "returns hint for empty query",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!buy sensors')");
    }),
  );

  test(
    "returns no matches when traders empty",
    Effect.gen(function* () {
      const result = yield* run({})("sensors");
      expect(result).toBe("[Warn] No trader sells: sensors");
    }),
  );

  test(
    "returns match for exact id",
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

      expect(result).toBe(
        "Power Cell can be purchased from Lance for 50 coins",
      );
    }),
  );

  test(
    "returns match for substring/name",
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

      expect(result).toBe(
        "Advanced Sensors can be purchased from Shani for 100 cred.",
      );
    }),
  );

  test(
    "Shani uses cred currency",
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

      expect(result).toMatch(/cred\./);
    }),
  );

  test(
    "Celeste uses seeds currency",
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

      expect(result).toMatch(/seeds/);
    }),
  );

  test(
    "default traders use coins",
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

      expect(result).toMatch(/coins/);
    }),
  );

  test(
    "preserves inventory and seller order across matching modes",
    Effect.gen(function* () {
      const result = yield* run({
        traders: {
          Apollo: [
            { id: "POWER-CELL", name: "Battery", trader_price: 5 },
            { id: "unrelated", name: "Unrelated", trader_price: 1 },
            { id: "compact", name: "PowerCell", trader_price: 6 },
          ],
          Celeste: [{ id: "cell", name: "Power Cell", trader_price: 7 }],
          Lance: [],
          Shani: [{ id: "spare", name: "Spare Power Cell", trader_price: 8 }],
          TianWen: [],
        },
      })("POWER CELL");

      expect(result).toBe(
        "Battery can be purchased from Apollo for 5 coins, PowerCell can be purchased from Apollo for 6 coins, Power Cell can be purchased from Celeste for 7 seeds, Spare Power Cell can be purchased from Shani for 8 cred.",
      );
    }),
  );

  test(
    "formats multiple matches",
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

      expect(result).toContain("Apollo");
      expect(result).toContain("Lance");
      expect(result).toContain("coins");
    }),
  );
});
