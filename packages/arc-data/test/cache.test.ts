import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { dataFromReader } from "../src/cache.js";
import { getItem } from "../src/items.js";
import { cacheKey, cachePolicy } from "../src/source.js";
import { makeFixture } from "./cache-fixture.js";

const { test: effectTest } = Test.make({ providers: Layer.empty });
const test = <E>(name: string, effect: Effect.Effect<void, E>) =>
  effectTest(name, effect.pipe(Effect.provide(TestClock.layer())));
const itemQuery = { resource: "items", params: { id: "sensors" } } as const;
const changed = {
  data: [{ id: "sensors", name: "New sensors", value: 20, future: "accepted" }],
  future: {},
};
const day = 86_400_000;

describe("persistent cache policy", () => {
  test(
    "cold reads, hits and the exact 24 hour edge use validated source data",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cold = yield* fixture.cache.read(itemQuery);
      expect(cold.provenance).toEqual({ freshness: "fresh", fetchedAt: 0 });
      fixture.body(changed);
      yield* TestClock.setTime(day - 1);
      expect(yield* fixture.cache.read(itemQuery)).toEqual(cold);
      expect(fixture.calls).toHaveLength(1);
      yield* TestClock.setTime(day);
      const refresh = yield* fixture.cache.read(itemQuery);
      expect(refresh.provenance).toEqual({
        freshness: "fresh",
        fetchedAt: day,
      });
      expect(JSON.parse(refresh.body).data[0]).toEqual({
        id: "sensors",
        name: "New sensors",
        value: 20,
      });
      expect(fixture.calls).toHaveLength(2);
    }),
  );

  for (const [name, body, status] of [
    ["status", changed, 503],
    [
      "schema",
      { data: [{ id: "sensors", name: "Broken", value: "wrong" }] },
      200,
    ],
    ["missing field", { data: [{ id: "sensors", value: 1 }] }, 200],
    ["parse", "not JSON", 200],
  ] as const) {
    test(
      `${name} failure preserves data and successful timestamp through persistent cooldown and day seven`,
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const original = yield* fixture.cache.read(itemQuery);
        if (name === "parse")
          fixture.respond(() => Effect.succeed(new Response("not JSON")));
        else fixture.body(body, status);
        yield* TestClock.setTime(day);
        const fallback = yield* fixture.cache.read(itemQuery);
        expect(fallback.body).toBe(original.body);
        expect(fallback.provenance).toEqual({
          freshness: "fallback",
          fetchedAt: 0,
        });
        const reconstructed = yield* fixture.reconstruct;
        yield* TestClock.setTime(day + 59_999);
        expect(yield* reconstructed.read(itemQuery)).toEqual(fallback);
        expect(fixture.calls).toHaveLength(2);
        yield* TestClock.setTime(day + 60_000);
        expect(yield* reconstructed.read(itemQuery)).toEqual(fallback);
        expect(fixture.calls).toHaveLength(3);
        yield* TestClock.setTime(7 * day);
        expect(yield* reconstructed.read(itemQuery)).toEqual(fallback);
        yield* TestClock.setTime(7 * day + 1);
        const failure = yield* reconstructed
          .read(itemQuery)
          .pipe(Effect.result);
        expect(failure._tag).toBe("Failure");
        if (failure._tag === "Failure")
          expect(failure.failure.message).toBe(
            "Game data is temporarily unavailable. Please try again shortly.",
          );
        expect(fixture.calls).toHaveLength(4);
      }),
    );
  }

  test(
    "network failure, missing fallback and a reconstructed failed cold read have a bounded cooldown",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.respond(() =>
        Effect.tryPromise({
          try: () => Promise.reject(new Error("fixture disconnect")),
          catch: () => new Error("fixture disconnect"),
        }),
      );
      const result = yield* fixture.cache.read(itemQuery).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.reason).toBe("source");
      const reconstructed = yield* fixture.reconstruct;
      expect(
        (yield* reconstructed.read(itemQuery).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(fixture.calls).toHaveLength(1);
      yield* TestClock.setTime(60_000);
      fixture.body(changed);
      expect((yield* reconstructed.read(itemQuery)).provenance.fetchedAt).toBe(
        60_000,
      );
      expect(fixture.calls).toHaveLength(2);
    }),
  );

  test(
    "null, omitted, Some, None and empty source results survive schema encoding and reconstruction",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({
        data: [
          {
            id: "a",
            name: "A",
            value: 10,
            workbench: null,
            components: [{ quantity: 2, component: { id: "c", name: "C" } }],
          },
          { id: "b", name: "B", value: 0, loot_area: "Industrial" },
        ],
      });
      const original = yield* fixture.data.items({
        id: "a",
        includeComponents: true,
      });
      const reconstructed = dataFromReader((yield* fixture.reconstruct).read);
      const result = yield* reconstructed.items({
        includeComponents: true,
        id: "a",
      });
      expect(result).toEqual(original);
      expect(result.value[0]?.workbench).toEqual(Option.none());
      expect(result.value[0]?.components).toEqual(
        Option.some([{ quantity: 2, component: { id: "c", name: "C" } }]),
      );
      expect(result.value[1]?.loot_area).toEqual(Option.some("Industrial"));
      fixture.body({ data: [] });
      expect(
        yield* getItem({ id: "empty" }).pipe(Effect.provide(fixture.layer)),
      ).toEqual(Option.none());
      expect(
        yield* getItem({ id: "empty" }).pipe(Effect.provide(fixture.layer)),
      ).toEqual(Option.none());
      fixture.body({ data: [{ id: "arc", name: "Arc", loot: null }] });
      expect((yield* fixture.data.arcs({ id: "arc" })).value[0]?.loot).toEqual(
        Option.none(),
      );
      fixture.body({ data: [{ id: "arc", name: "Arc", loot: [] }] });
      expect(
        (yield* fixture.data.arcs({ id: "empty-loot" })).value[0]?.loot,
      ).toEqual(Option.some([]));
      expect(fixture.calls).toHaveLength(4);
    }),
  );

  test(
    "endpoint, ID, search, flags, limit and encoding version distinguish canonical keys",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const queries = [
        itemQuery,
        { resource: "items", params: { search: "sensors" } },
        {
          resource: "items",
          params: { id: "sensors", includeComponents: true },
        },
        {
          resource: "items",
          params: { id: "sensors", includeComponents: false },
        },
        { resource: "items", params: { id: "sensors", minimal: true } },
        { resource: "items", params: { id: "sensors", minimal: false } },
        { resource: "items", params: { id: "sensors", limit: 1 } },
        { resource: "items", params: { id: "sensors", limit: 2 } },
        { resource: "arcs", params: { id: "sensors", includeLoot: true } },
        { resource: "arcs", params: { id: "sensors", includeLoot: false } },
      ] as const;
      expect(new Set(queries.map(cacheKey)).size).toBe(queries.length);
      expect(cacheKey(itemQuery)).toBe("v1:json:/items?id=sensors");
      expect(
        cacheKey({
          resource: "items",
          params: { minimal: true, id: "sensors" },
        }),
      ).toBe(cacheKey(queries[4]));
      for (const query of queries.slice(0, 8)) yield* fixture.cache.read(query);
      expect(fixture.calls).toHaveLength(8);
    }),
  );

  test(
    "query, entry, key and byte limits preserve usable fallback and reclaim only fully expired entries",
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        policy: {
          ...cachePolicy,
          maxKeys: 1,
          maxCacheBytes: 256,
          maxEntryBytes: 256,
        },
      });
      const original = yield* fixture.cache.read(itemQuery);
      expect(
        (yield* fixture.cache
          .read({ resource: "items", params: { id: "x".repeat(257) } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* fixture.cache
          .read({ resource: "items", params: { limit: 101 } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* fixture.cache
          .read({ resource: "items", params: { id: "other" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(fixture.calls).toHaveLength(1);
      yield* TestClock.setTime(day);
      fixture.body({
        data: [{ id: "sensors", name: "x".repeat(300), value: 10 }],
      });
      const fallback = yield* fixture.cache.read(itemQuery);
      expect(fallback.body).toBe(original.body);
      expect(fallback.provenance.fetchedAt).toBe(0);
      fixture.body(changed);
      yield* TestClock.setTime(7 * day + 1);
      yield* fixture.cache.read({ resource: "items", params: { id: "other" } });
      expect((yield* fixture.storage.entries()).size).toBe(1);
    }),
  );

  test(
    "same-key refreshes coalesce while independent keys progress",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.respond((url) =>
        url.searchParams.get("id") === "sensors"
          ? Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return Response.json(changed);
            })
          : Effect.succeed(Response.json(changed)),
      );
      const first = yield* fixture.cache.read(itemQuery).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* fixture.cache
        .read(itemQuery)
        .pipe(Effect.forkChild);
      const independent = yield* fixture.cache.read({
        resource: "items",
        params: { id: "other" },
      });
      expect(independent.provenance.freshness).toBe("fresh");
      expect(fixture.calls).toHaveLength(2);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
      expect(fixture.calls).toHaveLength(2);
    }),
  );

  test(
    "storage generations fence late completions after reset and engine reconstruction",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.respond(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return Response.json({
            data: [{ id: "sensors", name: "Old", value: 1 }],
          });
        }),
      );
      const first = yield* fixture.cache
        .read(itemQuery)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      yield* fixture.cache.reset;
      fixture.body(changed);
      const reconstructed = yield* fixture.reconstruct;
      const newer = yield* reconstructed.read(itemQuery);
      yield* Deferred.succeed(release, undefined);
      const late = yield* Fiber.join(first);
      expect(late._tag).toBe("Failure");
      if (late._tag === "Failure")
        expect(late.failure.reason).toBe("superseded");
      expect(yield* reconstructed.read(itemQuery)).toEqual(newer);
      expect(JSON.parse(newer.body).data[0].name).toBe("New sensors");
    }),
  );

  test(
    "schedule expires exactly at 60 seconds, never serves expired fallback and persists failure cooldown",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({
        data: [
          { name: "Harvester", map: "Dam", startTime: 0, endTime: 120_000 },
        ],
      });
      const original = yield* fixture.data.events();
      yield* TestClock.setTime(59_999);
      expect(yield* fixture.data.events()).toEqual(original);
      fixture.body({ error: "offline" }, 503);
      yield* TestClock.setTime(60_000);
      expect((yield* fixture.data.events().pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      const reconstructed = dataFromReader((yield* fixture.reconstruct).read);
      yield* TestClock.setTime(60_001);
      expect((yield* reconstructed.events().pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(fixture.calls).toHaveLength(2);
    }),
  );
  test(
    "a body over the source byte limit cannot replace valid data even when its consumed fields are compatible",
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        policy: { ...cachePolicy, maxBodyBytes: 256 },
      });
      const original = yield* fixture.cache.read(itemQuery);
      yield* TestClock.setTime(day);
      fixture.body({
        data: [{ id: "sensors", name: "Changed", value: 20 }],
        unused: "x".repeat(300),
      });
      const stale = yield* fixture.cache.read(itemQuery);
      expect(stale.body).toBe(original.body);
      expect(stale.provenance).toEqual({ freshness: "fallback", fetchedAt: 0 });
    }),
  );

  test(
    "total cache bytes reject a new value while retaining every usable fallback",
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        policy: { ...cachePolicy, maxCacheBytes: 100 },
      });
      const original = yield* fixture.cache.read(itemQuery);
      expect(
        (yield* fixture.cache
          .read({ resource: "items", params: { id: "other" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* fixture.cache.read(itemQuery)).toEqual(original);
      expect(fixture.calls).toHaveLength(2);
    }),
  );

  test(
    "persisted refresh leases survive interrupted execution and permit retry after the lease expires",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.respond(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return Response.json({
            data: [{ id: "sensors", name: "Interrupted", value: 1 }],
          });
        }),
      );
      const first = yield* fixture.cache
        .read(itemQuery)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const reconstructed = yield* fixture.reconstruct;
      const busy = yield* reconstructed.read(itemQuery).pipe(Effect.result);
      expect(busy._tag).toBe("Failure");
      if (busy._tag === "Failure")
        expect(busy.failure.reason).toBe("refreshing");
      expect(fixture.calls).toHaveLength(1);
      yield* Fiber.interrupt(first);
      fixture.body(changed);
      yield* TestClock.setTime(cachePolicy.sourceTimeoutMs + 1_000);
      const newer = yield* reconstructed.read(itemQuery);
      expect(JSON.parse(newer.body).data[0].name).toBe("New sensors");
      expect(yield* reconstructed.read(itemQuery)).toEqual(newer);
    }),
  );
  test(
    "a timed-out source preserves fallback and starts persistent cooldown without changing its successful age",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const original = yield* fixture.cache.read(itemQuery);
      yield* TestClock.setTime(day);
      const started = yield* Deferred.make<void>();
      fixture.respond(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      const refresh = yield* fixture.cache
        .read(itemQuery)
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(cachePolicy.sourceTimeoutMs);
      const stale = yield* Fiber.join(refresh);
      expect(stale).toEqual({
        body: original.body,
        provenance: { freshness: "fallback", fetchedAt: 0 },
      });
      const reconstructed = yield* fixture.reconstruct;
      expect(yield* reconstructed.read(itemQuery)).toEqual(stale);
      expect(fixture.calls).toHaveLength(2);
    }),
  );
});
