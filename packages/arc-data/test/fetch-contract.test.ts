import { BASE_API_URL } from "@arctools/utils";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { fetchArc, getEvents, getItem, getTraders } from "../src/index.js";

const baseUrl = `${BASE_API_URL.replace(/\/$/, "")}/`;

const mockClient = HttpClient.make((request) =>
  Effect.sync(() => {
    const url = request.url;
    if (!url.startsWith(baseUrl)) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ error: "unexpected" }), { status: 404 }),
      );
    }
    const path = url.slice(baseUrl.length).split("?")[0];
    if (path === "traders") {
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            data: {
              Apollo: [{ id: "a", name: "A", trader_price: 1 }],
              Celeste: [],
              Lance: [],
              Shani: [],
              TianWen: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (path === "items") {
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            data: [{ id: "item", name: "Item", value: 10 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (path === "arcs") {
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            data: [
              {
                id: "bastion",
                name: "Bastion",
                loot: [{ item: { id: "x", name: "X" } }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (path === "events-schedule") {
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            data: [
              {
                name: "Event",
                map: "Map",
                startTime: 1000,
                endTime: 2000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
  }),
);

const mockLayer = Layer.succeed(HttpClient.HttpClient, mockClient);

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
      const emptyClient = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ data: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      );
      const result = yield* getItem({ id: "missing" }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, emptyClient)),
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
