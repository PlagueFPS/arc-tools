/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test is an entry point that owns its injected layer scope. */
import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { rankSuggestions } from "../src/autocomplete.js";
import { cachePolicy } from "../src/source.js";
import { makeFixture } from "./cache-fixture.js";

const { test: effectTest } = Test.make({ providers: Layer.empty });

const test = <E>(name: string, effect: Effect.Effect<void, E>) =>
  effectTest(name, effect.pipe(Effect.provide(TestClock.layer())));

const items = { resource: "items-catalog" } as const;

const arcs = { resource: "arcs-catalog" } as const;

const page = (names: readonly string[]) => ({
  data: names.map((name) => ({ name })),
  pagination: {
    page: 1,
    total: names.length,
    totalPages: 1,
    hasNextPage: false,
  },
});

describe("cache-only autocomplete", () => {
  test(
    "empty input, ranking, deduplication and Discord bounds",
    Effect.sync(() => {
      expect(rankSuggestions(["Sensors"], "")).toEqual([]);
      expect(rankSuggestions(["Sensors"], " \t ")).toEqual([]);

      const names = [
        "XSensors",
        "sensors",
        "Sensors B",
        "Sensors A",
        "Sensors A",
      ];

      expect(
        rankSuggestions(names, " SENSORS ").map((row) => row.value),
      ).toEqual(["sensors", "Sensors A", "Sensors B", "XSensors"]);

      const many = Array.from(
        { length: 40 },
        (_, index) => `Item ${index.toString().padStart(2, "0")}`,
      );

      const suggestions = rankSuggestions(
        [...many.reverse(), "Item " + "x".repeat(100)],
        "item",
      );

      expect(suggestions).toHaveLength(25);
      expect(suggestions[0]).toEqual({ name: "Item 00", value: "Item 00" });
      expect(suggestions[24]?.name).toBe("Item 24");
    }),
  );

  test(
    "cold, warm, stale and expired suggestions never call source; refresh replaces and reset clears",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();

      for (const kind of ["items", "arcs", "events-maps"] as const)
        expect(yield* fixture.cache.suggest(kind, "sen")).toEqual([]);
      expect(fixture.calls).toHaveLength(0);

      fixture.body(page(["Sensors", "Sensor wire"]));
      yield* fixture.cache.read(items);
      expect(fixture.calls).toHaveLength(1);
      expect(yield* fixture.cache.suggest("items", "sen")).toHaveLength(2);
      const reconstructed = yield* fixture.reconstruct;
      expect(yield* reconstructed.suggest("items", "sen")).toHaveLength(2);
      yield* TestClock.setTime(cachePolicy.metadataFreshMs);
      expect(yield* reconstructed.suggest("items", "sen")).toHaveLength(2);
      expect(fixture.calls).toHaveLength(1);
      fixture.body(page(["Sensor replacement"]));
      yield* fixture.cache.read(items);
      expect(yield* fixture.cache.suggest("items", "sen")).toEqual([
        { name: "Sensor replacement", value: "Sensor replacement" },
      ]);
      expect(fixture.calls).toHaveLength(2);
      yield* TestClock.setTime(
        cachePolicy.metadataFallbackMs + cachePolicy.metadataFreshMs + 1,
      );
      expect(yield* fixture.cache.suggest("items", "sen")).toEqual([]);
      expect(fixture.calls).toHaveLength(2);
      yield* fixture.cache.read(items);
      expect(fixture.calls).toHaveLength(3);
      yield* fixture.cache.reset;
      expect(yield* fixture.cache.suggest("items", "sen")).toEqual([]);
      expect(fixture.calls).toHaveLength(3);
    }),
  );

  test(
    "search rows cannot become a catalog; pagination visits every page for both catalogs",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.data.items({ search: "Sensors" });
      expect(yield* fixture.cache.suggest("items", "sen")).toEqual([]);
      fixture.respond((url) => {
        const number = Number(url.searchParams.get("page"));

        return Effect.succeed(
          Response.json({
            data: [{ name: number === 1 ? "Sensors" : "Sensor wire" }],
            pagination: {
              page: number,
              total: 2,
              totalPages: 2,
              hasNextPage: number === 1,
            },
          }),
        );
      });

      for (const query of [items, arcs]) {
        yield* fixture.cache.read(query);
        const kind = query.resource === "items-catalog" ? "items" : "arcs";
        expect(yield* fixture.cache.suggest(kind, "sen")).toHaveLength(2);
      }

      expect(fixture.calls).toHaveLength(5);
      expect(fixture.calls.slice(1).map((url) => new URL(url).search)).toEqual([
        "?limit=100&page=1",
        "?limit=100&page=2",
        "?limit=100&page=1",
        "?limit=100&page=2",
      ]);
    }),
  );

  test(
    "failed or incomplete refresh retains successful catalog and eviction removes it",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body(page(["Sensors"]));
      yield* fixture.cache.read(items);
      fixture.body({
        data: [{ name: "Replacement" }],
        pagination: { page: 1, total: 2, totalPages: 1, hasNextPage: false },
      });
      yield* TestClock.setTime(cachePolicy.metadataFreshMs);
      yield* fixture.cache.read(items);
      expect(yield* fixture.cache.suggest("items", "sen")).toHaveLength(1);
      expect(yield* fixture.cache.suggest("items", "rep")).toEqual([]);
      expect(fixture.calls).toHaveLength(2);
      yield* TestClock.setTime(cachePolicy.metadataFallbackMs + 1);
      fixture.body(page(["Other ARC"]));
      yield* fixture.cache.read(arcs);
      expect((yield* fixture.storage.entries).size).toBe(1);
      expect(yield* fixture.cache.suggest("items", "sen")).toEqual([]);
      expect(fixture.calls).toHaveLength(3);
    }),
  );

  test(
    "event maps come only from the usable schedule and share its expiry and reset",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({
        data: [
          { name: "Night", map: "Spaceport", startTime: 1, endTime: 2 },
          { name: "Storm", map: "Spaceport", startTime: 3, endTime: 4 },
        ],
      });
      yield* fixture.data.events;
      expect(yield* fixture.cache.suggest("events-maps", "space")).toEqual([
        { name: "Spaceport", value: "Spaceport" },
      ]);
      yield* TestClock.setTime(cachePolicy.scheduleFreshMs);
      expect(yield* fixture.cache.suggest("events-maps", "space")).toEqual([]);
      expect(fixture.calls).toHaveLength(1);
      fixture.body({
        data: [
          { name: "Night", map: "New Spaceport", startTime: 1, endTime: 2 },
        ],
      });
      yield* fixture.data.events;
      expect(yield* fixture.cache.suggest("events-maps", "space")).toEqual([
        { name: "New Spaceport", value: "New Spaceport" },
      ]);
      yield* fixture.cache.reset;
      expect(yield* fixture.cache.suggest("events-maps", "space")).toEqual([]);
      expect(fixture.calls).toHaveLength(2);
    }),
  );
});
