import { expect } from "bun:test";

import { Effect, Fiber, Option, Schema, Record as Rec } from "effect";

import { EncodedRead } from "../../packages/arc-data/src/cache.js";
import {
  DataUnavailable,
  type ResourceQuery,
} from "../../packages/arc-data/src/data-service.js";
import { ItemAPIResponse } from "../../packages/arc-data/src/schema.js";
import { CacheSnapshot } from "./cache-fixture.js";
import { retainJourney } from "./fixture-evidence.js";
import {
  auditedObservation,
  observe,
  get,
  json,
  post,
  reconstructedSnapshot,
} from "./fixture-http.js";
import { withSourceHold } from "./fixture-journey.js";
import { cacheJourney } from "./fixture-routing.js";
import type * as Foundation from "./foundation.test.js";
import { Observations, type SourceControl } from "./metaforge.js";

const ReadReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), result: EncodedRead }),
  Schema.Struct({ kind: Schema.Literal("failure"), error: DataUnavailable }),
]);

const day = 86_400_000;

const read = Effect.fnUntraced(function* (url: string, query: ResourceQuery) {
  const response = yield* post(`${url}/read`, query);

  return yield* json(response, ReadReply);
});

const successful = Effect.fnUntraced(function* (
  url: string,
  query: ResourceQuery,
) {
  const result = yield* read(url, query);
  expect(result.kind).toBe("success");

  if (result.kind === "failure") return yield* result.error;

  return result.result;
});

const snapshot = (url: string) => get(`${url}/snapshot`, CacheSnapshot);

const observations = (url: string) => get(`${url}/observations`, Observations);

const configure = (url: string, control: typeof SourceControl.Type) =>
  post(`${url}/control`, control);

const query = (id: string): ResourceQuery => ({
  resource: "items",
  params: { id },
});

export function registerCacheTests({
  stack,
  test,
}: Pick<typeof Foundation, "stack" | "test">) {
  const fixture = Effect.fnUntraced(function* (name: string) {
    const deployed = yield* stack;

    if (!deployed.cacheUrl || !deployed.sourceUrl)
      return yield* Effect.die("Cache test outputs are missing");

    yield* retainJourney(name, { phase: "start" });

    const { url, source } = cacheJourney(
      { cache: deployed.cacheUrl, source: deployed.sourceUrl },
      name,
    );

    yield* observations(source);
    yield* snapshot(url);
    yield* post(`${url}/time`, 0);

    return { url, source };
  });

  test(
    "real cache storage round-trips Options, survives native reconstruction and refreshes only at 24 hours",
    Effect.gen(function* () {
      const { url, source } = yield* fixture("cache-persist");
      const input = query("persist");
      const first = yield* successful(url, input);
      const before = yield* snapshot(url);
      expect(Rec.keys(before.rows)).toEqual([
        "entry:v1:json:/items?id=persist",
      ]);
      expect(first.provenance).toEqual({ freshness: "fresh", fetchedAt: 0 });

      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(ItemAPIResponse),
      )(first.body);

      expect(decoded.data[0]?.workbench).toEqual(Option.none());
      expect(decoded.data[0]?.loot_area).toEqual(Option.some("Industrial"));
      expect(decoded.data[0]?.components).toEqual(Option.some([]));
      yield* post(`${url}/reconstruct`);

      const after = yield* reconstructedSnapshot(
        snapshot(url),
        before.instance,
      );

      expect(after.instance).not.toBe(before.instance);
      expect(after.rows).toEqual(before.rows);
      yield* post(`${url}/time`, day - 1);
      expect(yield* successful(url, input)).toEqual(first);
      expect((yield* observations(source))["/items?id=persist"]).toBe(1);
      yield* configure(source, {
        key: "/items?id=persist",
        body: {
          data: [{ id: "persist", name: "Updated", value: 20, extra: true }],
          extra: "accepted",
        },
      });
      yield* post(`${url}/time`, day);
      const refreshed = yield* successful(url, input);
      expect(refreshed.provenance).toEqual({
        freshness: "fresh",
        fetchedAt: day,
      });
      expect(
        (yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toEncoded(ItemAPIResponse)),
          { onExcessProperty: "error" },
        )(refreshed.body).pipe(Effect.orDie)).data[0],
      ).toEqual({
        id: "persist",
        name: "Updated",
        value: 20,
      });
      expect((yield* observations(source))["/items?id=persist"]).toBe(2);
    }),
    { timeout: 90_000 },
  );

  test(
    "schema, status and parse failures preserve original data, timestamp and persistent cooldown through the day-seven edge",
    Effect.gen(function* () {
      const { url, source } = yield* fixture("cache-failure");

      for (const [id, body, status, raw] of [
        [
          "schema",
          { data: [{ id: "x", name: "X", value: "broken" }] },
          200,
          false,
        ],
        ["status", { error: "offline" }, 503, false],
        ["parse", "bad JSON", 200, true],
      ] as const) {
        yield* post(`${url}/time`, 0);
        const input = query(id);
        const original = yield* successful(url, input);
        yield* configure(source, { key: `/items?id=${id}`, body, status, raw });
        yield* post(`${url}/time`, day);
        const stale = yield* successful(url, input);
        expect(stale).toEqual({
          body: original.body,
          provenance: { freshness: "fallback", fetchedAt: 0 },
        });
        yield* post(`${url}/reconstruct`);
        yield* snapshot(url);
        yield* post(`${url}/time`, day + 59_999);
        expect(yield* successful(url, input)).toEqual(stale);
        expect((yield* observations(source))[`/items?id=${id}`]).toBe(2);
        yield* post(`${url}/time`, day + 60_000);
        expect(yield* successful(url, input)).toEqual(stale);
        expect((yield* observations(source))[`/items?id=${id}`]).toBe(3);
        yield* post(`${url}/time`, day * 7);
        expect(yield* successful(url, input)).toEqual(stale);
        yield* post(`${url}/time`, day * 7 + 1);
        expect((yield* read(url, input)).kind).toBe("failure");
        expect((yield* observations(source))[`/items?id=${id}`]).toBe(4);
      }
    }),
    { timeout: 120_000 },
  );

  test(
    "real schedule storage expires at 60 seconds and rejects stale fallback after source failure and reconstruction",
    Effect.gen(function* () {
      const { url, source } = yield* fixture("cache-schedule");
      yield* configure(source, {
        key: "/events-schedule",
        body: {
          data: [
            { name: "Harvester", map: "Dam", startTime: 0, endTime: 120_000 },
          ],
        },
      });
      const input = { resource: "events-schedule" } as const;
      const first = yield* successful(url, input);
      yield* post(`${url}/time`, 59_999);
      expect(yield* successful(url, input)).toEqual(first);
      yield* configure(source, {
        key: "/events-schedule",
        body: {},
        status: 503,
      });
      yield* post(`${url}/time`, 60_000);
      expect((yield* read(url, input)).kind).toBe("failure");
      yield* post(`${url}/reconstruct`);
      yield* snapshot(url);
      yield* post(`${url}/time`, 60_001);
      expect((yield* read(url, input)).kind).toBe("failure");
      expect((yield* observations(source))["/events-schedule"]).toBe(2);
    }),
    { timeout: 90_000 },
  );

  test(
    "same-key local refreshes coalesce, independent keys progress and reset fences a late source completion",
    Effect.gen(function* () {
      const { url, source } = yield* fixture("cache-contention");
      const key = "/items?id=held";
      const input = query("held");
      yield* withSourceHold(
        source,
        { key, body: { data: [{ id: "held", name: "Old", value: 1 }] } },
        Effect.fnUntraced(function* (control) {
          const first = yield* read(url, input).pipe(Effect.forkScoped);
          yield* observe(
            auditedObservation(
              "source",
              `${source}/observations`,
              Observations,
            ),
            { until: (calls) => calls[key] === 1, budgetMs: 5000 },
          );
          const second = yield* read(url, input).pipe(Effect.forkScoped);
          const independent = yield* successful(url, query("independent"));
          expect(independent.provenance.freshness).toBe("fresh");
          expect((yield* observations(source))[key]).toBe(1);
          yield* control.release;
          expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
          expect((yield* observations(source))[key]).toBe(1);
        }),
      );
      const lateKey = "/items?id=late";
      const lateInput = query("late");
      yield* withSourceHold(
        source,
        {
          key: lateKey,
          body: { data: [{ id: "late", name: "Obsolete", value: 1 }] },
        },
        Effect.fnUntraced(function* (control) {
          const late = yield* read(url, lateInput).pipe(Effect.forkScoped);
          yield* observe(
            auditedObservation(
              "source",
              `${source}/observations`,
              Observations,
            ),
            { until: (calls) => calls[lateKey] === 1, budgetMs: 5000 },
          );
          yield* post(`${url}/clear`);
          yield* configure(source, {
            key: lateKey,
            body: { data: [{ id: "late", name: "Current", value: 2 }] },
          });
          const newer = yield* successful(url, lateInput);
          yield* control.release;
          const old = yield* Fiber.join(late);
          expect(old.kind).toBe("failure");

          if (old.kind === "failure")
            expect(old.error.reason).toBe("superseded");
          expect(yield* successful(url, lateInput)).toEqual(newer);
          expect(
            (yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.toEncoded(ItemAPIResponse)),
              { onExcessProperty: "error" },
            )(newer.body).pipe(Effect.orDie)).data[0]?.name,
          ).toBe("Current");
          yield* post(`${url}/reconstruct`);
          expect(
            (yield* snapshot(url)).rows["entry:v1:json:/items?id=late"]?.value
              ?.body,
          ).toBe(newer.body);
        }),
      );
    }),
    { timeout: 90_000 },
  );
  test(
    "real cache keys keep ID, search, response flags and limits separate, including valid empty responses",
    Effect.gen(function* () {
      const { url, source } = yield* fixture("cache-keys");

      const cases = [
        [{ resource: "items", params: { id: "flags" } }, "/items?id=flags"],
        [
          { resource: "items", params: { search: "flags" } },
          "/items?search=flags",
        ],
        [
          {
            resource: "items",
            params: { id: "flags", includeComponents: true },
          },
          "/items?id=flags&includeComponents=true",
        ],
        [
          { resource: "items", params: { id: "flags", minimal: true } },
          "/items?id=flags&minimal=true",
        ],
        [
          { resource: "items", params: { id: "flags", limit: 1 } },
          "/items?id=flags&limit=1",
        ],
        [
          { resource: "items", params: { id: "flags", limit: 2 } },
          "/items?id=flags&limit=2",
        ],
        [
          { resource: "arcs", params: { id: "flags", includeLoot: true } },
          "/arcs?id=flags&includeLoot=true",
        ],
        [
          { resource: "arcs", params: { id: "flags", includeLoot: false } },
          "/arcs?id=flags&includeLoot=false",
        ],
      ] as const;

      for (const [input, key] of cases) {
        const first = yield* successful(url, input);
        expect(yield* successful(url, input)).toEqual(first);
        expect((yield* observations(source))[key]).toBe(1);
      }

      yield* successful(url, {
        resource: "items",
        params: { includeComponents: true, id: "flags" },
      });
      expect(
        (yield* observations(source))["/items?id=flags&includeComponents=true"],
      ).toBe(1);
      yield* configure(source, { key: "/items?id=empty", body: { data: [] } });
      const empty = yield* successful(url, query("empty"));
      expect(
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toEncoded(ItemAPIResponse)),
          { onExcessProperty: "error" },
        )(empty.body).pipe(Effect.orDie),
      ).toEqual({ data: [] });
      expect(yield* successful(url, query("empty"))).toEqual(empty);
      expect((yield* observations(source))["/items?id=empty"]).toBe(1);
    }),
    { timeout: 90_000 },
  );
}
