import { layerUncached } from "@arctools/arc-data";
import { BASE_API_URL } from "@arctools/utils";
import {
  pipe,
  Effect,
  Layer,
  Array as Arr,
  String as Str,
  Schema,
} from "effect";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export interface MockTraders {
  Apollo: Array<{ id: string; name: string; trader_price: number }>;
  Celeste: Array<{ id: string; name: string; trader_price: number }>;
  Lance: Array<{ id: string; name: string; trader_price: number }>;
  Shani: Array<{ id: string; name: string; trader_price: number }>;
  TianWen: Array<{ id: string; name: string; trader_price: number }>;
}

/** Raw API shape for items - optional fields can be null/undefined */
export interface MockItem {
  id: string;
  name: string;
  value: number;
  workbench?: string | null;
  loot_area?: string | null;
  components?: Array<{
    quantity: number;
    component: { id: string; name: string };
  }> | null;
  recycle_components?: Array<{
    quantity: number;
    component: { id: string; name: string };
  }> | null;
  recycle_from?: Array<{
    quantity: number;
    item: { id: string; name: string };
  }> | null;
  dropped_by?: Array<{ arc: { id: string; name: string } }> | null;
}

/** Raw API shape for arcs - loot can be null/undefined */
export interface MockArc {
  id: string;
  name: string;
  loot?: Array<{ item: { id: string; name: string } }> | null;
}

export interface MockEvent {
  name: string;
  map: string;
  startTime: number;
  endTime: number;
}

export interface MockData {
  traders?: MockTraders;
  items?: MockItem[];
  arcs?: MockArc[];
  events?: MockEvent[];
}

const emptyTraders: MockTraders = {
  Apollo: [],
  Celeste: [],
  Lance: [],
  Shani: [],
  TianWen: [],
};

export function createMockHttpClientLayer(mock: MockData) {
  const traders = mock.traders ?? emptyTraders;
  const items = mock.items ?? [];
  const arcs = mock.arcs ?? [];
  const events = mock.events ?? [];

  const baseUrl = `${Str.replace(/\/$/, "")(BASE_API_URL)}/`;

  const mockClient = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const url = request.url;

        if (!Str.startsWith(baseUrl)(url)) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                { error: "unexpected url" },
              ),
              {
                status: 404,
              },
            ),
          );
        }

        const path = pipe(url, Str.slice(baseUrl.length), Str.split("?"))[0];

        if (path === "traders") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                { data: traders },
              ),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        if (path === "items") {
          const params = new URL(url).searchParams;
          const id = params.get("id");
          const search = params.get("search");
          let matched = items;

          if (id) {
            matched = Arr.filter(
              items,
              (i) => !!(Str.toLowerCase(i.id) === Str.toLowerCase(id)),
            );
          } else if (search) {
            const norm = pipe(search, Str.toLowerCase, Str.replace(/\s/g, ""));

            matched = Arr.filter(
              items,
              (i: MockItem) =>
                !!pipe(
                  i.name,
                  Str.toLowerCase,
                  Str.replace(/\s/g, ""),
                  Str.includes(norm),
                ),
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                { data: matched },
              ),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        if (path === "arcs") {
          const params = new URL(url).searchParams;
          const id = params.get("id");
          const search = params.get("search");
          let matched = arcs;

          if (id) {
            matched = Arr.filter(
              arcs,
              (a) => !!(Str.toLowerCase(a.id) === Str.toLowerCase(id)),
            );
          } else if (search) {
            const norm = pipe(search, Str.toLowerCase, Str.replace(/\s/g, ""));

            matched = Arr.filter(
              arcs,
              (a: MockArc) =>
                !!pipe(
                  a.name,
                  Str.toLowerCase,
                  Str.replace(/\s/g, ""),
                  Str.includes(norm),
                ),
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                { data: matched },
              ),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        if (path === "events-schedule") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                { data: events },
              ),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        return HttpClientResponse.fromWeb(
          request,
          new Response(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              error: "not found",
            }),
            { status: 404 },
          ),
        );
      }).pipe(Effect.orDie),
  );

  return layerUncached.pipe(
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, mockClient)),
  );
}
