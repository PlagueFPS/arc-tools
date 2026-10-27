import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Exit, Layer, Schema } from "effect";

import {
  ArcsAPIResponse,
  EventAPIResponse,
  ItemAPIResponse,
  TradersAPIResponse,
} from "../src/schema.js";

const { test } = Test.make({ providers: Layer.empty });

describe("TradersAPIResponse", () => {
  test(
    "decodes valid payload",
    Effect.gen(function* () {
      const payload = {
        data: {
          Apollo: [],
          Celeste: [],
          Lance: [{ id: "x", name: "X", trader_price: 10 }],
          Shani: [],
          TianWen: [],
        },
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(TradersAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );

  test(
    "fails on malformed data",
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(TradersAPIResponse)({ data: null }),
      );

      expect(Exit.isFailure(result)).toBeTrue();
    }),
  );
});

describe("ArcsAPIResponse", () => {
  test(
    "decodes valid payload",
    Effect.gen(function* () {
      const payload = {
        data: [
          {
            id: "bastion",
            name: "Bastion",
            loot: [{ item: { id: "x", name: "X" } }],
          },
        ],
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(ArcsAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );

  test(
    "decodes arc with null loot",
    Effect.gen(function* () {
      const payload = {
        data: [{ id: "a", name: "A", loot: null }],
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(ArcsAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );
});

describe("ItemAPIResponse", () => {
  test(
    "decodes valid payload with optional nulls",
    Effect.gen(function* () {
      const payload = {
        data: [
          {
            id: "item",
            name: "Item",
            value: 10,
            workbench: null,
            loot_area: null,
            components: null,
            recycle_components: null,
            recycle_from: null,
            dropped_by: null,
          },
        ],
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(ItemAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );

  test(
    "decodes item with optional fields omitted",
    Effect.gen(function* () {
      const payload = {
        data: [{ id: "x", name: "X", value: 5 }],
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(ItemAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );
});

describe("EventAPIResponse", () => {
  test(
    "decodes valid payload",
    Effect.gen(function* () {
      const payload = {
        data: [
          {
            name: "Event",
            map: "Map",
            startTime: 1000,
            endTime: 2000,
          },
        ],
      };

      const result = yield* Effect.exit(
        Schema.decodeEffect(EventAPIResponse)(payload),
      );

      expect(Exit.isSuccess(result)).toBeTrue();
    }),
  );
});
