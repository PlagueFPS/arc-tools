import { createMockHttpClientLayer } from "@arctools/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { fetchArc, getEvents, getItem, getTraders } from "../src/index.js";

const mockLayer = createMockHttpClientLayer({
  traders: {
    Apollo: [{ id: "a", name: "A", trader_price: 1 }],
    Celeste: [],
    Lance: [],
    Shani: [],
    TianWen: [],
  },
  items: [{ id: "item", name: "Item", value: 10 }],
  arcs: [
    {
      id: "bastion",
      name: "Bastion",
      loot: [{ item: { id: "x", name: "X" } }],
    },
  ],
  events: [
    {
      name: "Event",
      map: "Map",
      startTime: 1000,
      endTime: 2000,
    },
  ],
});

describe("fetch contract", () => {
  it.effect("getTraders decodes and returns data", () =>
    Effect.gen(function* () {
      const result = yield* getTraders().pipe(Effect.provide(mockLayer));
      const first = result.Apollo[0];
      assert.isDefined(first);
      assert.strictEqual(first?.name, "A");
    }),
  );

  it.effect("getItem decodes and returns head", () =>
    Effect.gen(function* () {
      const result = yield* getItem({ id: "item" }).pipe(
        Effect.provide(mockLayer),
      );
      const item = Option.getOrThrow(result);
      assert.strictEqual(item.name, "Item");
    }),
  );

  it.effect("getItem returns none for empty response", () =>
    Effect.gen(function* () {
      const emptyLayer = createMockHttpClientLayer({});
      const result = yield* getItem({ id: "missing" }).pipe(
        Effect.provide(emptyLayer),
      );
      assert.isTrue(Option.isNone(result));
    }),
  );

  it.effect("fetchArc decodes and returns head", () =>
    Effect.gen(function* () {
      const result = yield* fetchArc({ id: "bastion" }).pipe(
        Effect.provide(mockLayer),
      );
      const arc = Option.getOrThrow(result);
      assert.strictEqual(arc.name, "Bastion");
    }),
  );

  it.effect("getEvents decodes and returns data", () =>
    Effect.gen(function* () {
      const result = yield* getEvents().pipe(Effect.provide(mockLayer));
      const first = result[0];
      assert.isDefined(first);
      assert.strictEqual(first?.name, "Event");
    }),
  );
});
