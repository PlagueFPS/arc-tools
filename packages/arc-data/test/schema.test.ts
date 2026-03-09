import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import {
  ArcsAPIResponse,
  EventAPIResponse,
  ItemAPIResponse,
  TradersAPIResponse,
} from "../src/schema.js";

describe("TradersAPIResponse", () => {
  it.effect("decodes valid payload", () =>
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
        Schema.decodeUnknownEffect(TradersAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );

  it.effect("fails on malformed data", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(TradersAPIResponse)({ data: null }),
      );
      assert.isTrue(Exit.isFailure(result));
    }),
  );
});

describe("ArcsAPIResponse", () => {
  it.effect("decodes valid payload", () =>
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
        Schema.decodeUnknownEffect(ArcsAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );

  it.effect("decodes arc with null loot", () =>
    Effect.gen(function* () {
      const payload = {
        data: [{ id: "a", name: "A", loot: null }],
      };
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(ArcsAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );
});

describe("ItemAPIResponse", () => {
  it.effect("decodes valid payload with optional nulls", () =>
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
        Schema.decodeUnknownEffect(ItemAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );

  it.effect("decodes item with optional fields omitted", () =>
    Effect.gen(function* () {
      const payload = {
        data: [{ id: "x", name: "X", value: 5 }],
      };
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(ItemAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );
});

describe("EventAPIResponse", () => {
  it.effect("decodes valid payload", () =>
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
        Schema.decodeUnknownEffect(EventAPIResponse)(payload),
      );
      assert.isTrue(Exit.isSuccess(result));
    }),
  );
});
