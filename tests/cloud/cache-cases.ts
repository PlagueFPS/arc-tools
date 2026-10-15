import { expect } from "bun:test";
import { Effect, Fiber, Option, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import { EncodedRead } from "../../packages/arc-data/src/cache.js";
import {
  DataUnavailable,
  type ResourceQuery,
} from "../../packages/arc-data/src/data-service.js";
import { ItemAPIResponse } from "../../packages/arc-data/src/schema.js";
import { CacheSnapshot } from "./cache-fixture.js";
import type * as Foundation from "./foundation.test.js";
import { Observations, type SourceControl } from "./metaforge.js";

const ReadReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), result: EncodedRead }),
  Schema.Struct({ kind: Schema.Literal("failure"), error: DataUnavailable }),
]);
const day = 86_400_000;
class FixtureRouteNotReady extends Schema.TaggedError<FixtureRouteNotReady>()(
  "FixtureRouteNotReady",
  {},
) {}
const post = Effect.fnUntraced(
  function* (url: string, body?: unknown) {
    const response = yield* Effect.promise(() =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (response.status === 404) return yield* new FixtureRouteNotReady();
    if (!response.ok)
      return yield* Effect.fail(
        new Error(
          `Fixture POST ${new URL(url).pathname}: ${response.status} ${(yield* Effect.promise(() => response.text())).slice(0, 512)}`,
        ),
      );
    return response;
  },
  (effect) =>
    effect.pipe(
      Effect.retry({
        while: (error) => error instanceof FixtureRouteNotReady,
        times: 4,
        schedule: Schedule.spaced("200 millis"),
      }),
    ),
);

const read = Effect.fnUntraced(function* (url: string, query: ResourceQuery) {
  const response = yield* post(`${url}/read`, query);
  return yield* Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ReadReply)),
  );
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
const snapshot = Effect.fnUntraced(function* (url: string) {
  const response = yield* HttpClient.get(`${url}/snapshot`).pipe(
    Effect.flatMap((response) =>
      response.status === 200 &&
      response.headers["content-type"]?.includes("application/json")
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new Error(
                  `Cache snapshot ${response.status}: ${body.slice(0, 512)}`,
                ),
              ),
            ),
          ),
    ),
    Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }),
  );
  expect(response.status).toBe(200);
  return yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CacheSnapshot)),
  );
});
const observations = Effect.fnUntraced(function* (url: string) {
  const response = yield* HttpClient.get(`${url}/observations`).pipe(
    Effect.flatMap((response) =>
      response.status === 200 &&
      response.headers["content-type"]?.includes("application/json")
        ? Effect.succeed(response)
        : Effect.fail(new FixtureRouteNotReady()),
    ),
    Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }),
  );
  return yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Observations)),
  );
});
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
  const fixture = Effect.gen(function* () {
    const deployed = yield* stack;
    if (!deployed.cacheUrl || !deployed.sourceUrl)
      return yield* Effect.die("Cache test outputs are missing");
    const url = deployed.cacheUrl;
    const source = deployed.sourceUrl;
    yield* observations(source);
    yield* snapshot(url);
    yield* post(`${url}/clear`);
    yield* post(`${url}/time`, 0);
    return { url, source };
  });

  test(
    "real cache storage round-trips Options, survives native reconstruction and refreshes only at 24 hours",
    Effect.gen(function* () {
      const { url, source } = yield* fixture;
      const input = query("persist");
      const first = yield* successful(url, input);
      const before = yield* snapshot(url);
      expect(Object.keys(before.rows)).toEqual([
        "entry:v1:json:/items?id=persist",
      ]);
      expect(first.provenance).toEqual({ freshness: "fresh", fetchedAt: 0 });
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ItemAPIResponse),
      )(first.body);
      expect(decoded.data[0]?.workbench).toEqual(Option.none());
      expect(decoded.data[0]?.loot_area).toEqual(Option.some("Industrial"));
      expect(decoded.data[0]?.components).toEqual(Option.some([]));
      yield* post(`${url}/reconstruct`);
      const after = yield* snapshot(url);
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
      expect(JSON.parse(refreshed.body).data[0]).toEqual({
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
      const { url, source } = yield* fixture;
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
      const { url, source } = yield* fixture;
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
    "same-key cloud refreshes coalesce, independent keys progress and reset fences a late source completion",
    Effect.gen(function* () {
      const { url, source } = yield* fixture;
      const key = "/items?id=held";
      const input = query("held");
      yield* configure(source, {
        key,
        body: { data: [{ id: "held", name: "Old", value: 1 }] },
        hold: true,
      });
      const first = yield* read(url, input).pipe(Effect.forkChild);
      yield* observations(source).pipe(
        Effect.repeat({
          until: (calls) => calls[key] === 1,
          times: 20,
          schedule: Schedule.spaced("100 millis"),
        }),
      );
      const second = yield* read(url, input).pipe(Effect.forkChild);
      const independent = yield* successful(url, query("independent"));
      expect(independent.provenance.freshness).toBe("fresh");
      expect((yield* observations(source))[key]).toBe(1);
      yield* post(`${source}/release`, key);
      expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
      expect((yield* observations(source))[key]).toBe(1);

      const lateKey = "/items?id=late";
      const lateInput = query("late");
      yield* configure(source, {
        key: lateKey,
        body: { data: [{ id: "late", name: "Obsolete", value: 1 }] },
        hold: true,
      });
      const late = yield* read(url, lateInput).pipe(Effect.forkChild);
      yield* observations(source).pipe(
        Effect.repeat({
          until: (calls) => calls[lateKey] === 1,
          times: 20,
          schedule: Schedule.spaced("100 millis"),
        }),
      );
      yield* post(`${url}/clear`);
      yield* configure(source, {
        key: lateKey,
        body: { data: [{ id: "late", name: "Current", value: 2 }] },
      });
      const newer = yield* successful(url, lateInput);
      yield* post(`${source}/release`, lateKey);
      const old = yield* Fiber.join(late);
      expect(old.kind).toBe("failure");
      if (old.kind === "failure") expect(old.error.reason).toBe("superseded");
      expect(yield* successful(url, lateInput)).toEqual(newer);
      expect(JSON.parse(newer.body).data[0].name).toBe("Current");
      yield* post(`${url}/reconstruct`);
      expect(
        (yield* snapshot(url)).rows["entry:v1:json:/items?id=late"]?.value
          ?.body,
      ).toBe(newer.body);
    }),
    { timeout: 90_000 },
  );
  test(
    "real cache keys keep ID, search, response flags and limits separate, including valid empty responses",
    Effect.gen(function* () {
      const { url, source } = yield* fixture;
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
      expect(JSON.parse(empty.body)).toEqual({ data: [] });
      expect(yield* successful(url, query("empty"))).toEqual(empty);
      expect((yield* observations(source))["/items?id=empty"]).toBe(1);
    }),
    { timeout: 90_000 },
  );
}
