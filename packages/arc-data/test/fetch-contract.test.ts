import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  fetchArc,
  getEvents,
  getItem,
  getTraders,
  layerUncached,
} from "../src/index.js";

const fixture = {
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
};
const mockLayer = layerUncached.pipe(
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const resource = new URL(request.url).pathname.split("/").at(-1);
        const data =
          resource === "items"
            ? fixture.items
            : resource === "arcs"
              ? fixture.arcs
              : resource === "traders"
                ? fixture.traders
                : fixture.events;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data })),
        );
      }),
    ),
  ),
);

const { test } = Test.make({ providers: Layer.empty });

describe("fetch contract", () => {
  test(
    "getTraders decodes and returns data",
    Effect.gen(function* () {
      const result = yield* getTraders().pipe(Effect.provide(mockLayer));
      const first = result.Apollo[0];
      expect(first).toBeDefined();
      expect(first?.name).toBe("A");
    }),
  );

  test(
    "getItem decodes and returns head",
    Effect.gen(function* () {
      const result = yield* getItem({ id: "item" }).pipe(
        Effect.provide(mockLayer),
      );
      const item = Option.getOrThrow(result);
      expect(item.name).toBe("Item");
    }),
  );

  test(
    "getItem returns none for empty response",
    Effect.gen(function* () {
      const emptyLayer = layerUncached.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ data: [] }),
                ),
              ),
            ),
          ),
        ),
      );
      const result = yield* getItem({ id: "missing" }).pipe(
        Effect.provide(emptyLayer),
      );
      expect(Option.isNone(result)).toBeTrue();
    }),
  );

  test(
    "fetchArc decodes and returns head",
    Effect.gen(function* () {
      const result = yield* fetchArc({ id: "bastion" }).pipe(
        Effect.provide(mockLayer),
      );
      const arc = Option.getOrThrow(result);
      expect(arc.name).toBe("Bastion");
    }),
  );

  test(
    "getEvents decodes and returns data",
    Effect.gen(function* () {
      const result = yield* getEvents().pipe(Effect.provide(mockLayer));
      const first = result[0];
      expect(first).toBeDefined();
      expect(first?.name).toBe("Event");
    }),
  );
});
