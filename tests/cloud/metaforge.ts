import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { identifyFixtureResponse } from "./fixture-response.js";

export const SourceControl = Schema.Struct({
  key: Schema.String,
  status: Schema.optional(Schema.Int),
  body: Schema.Json,
  delayMs: Schema.optional(Schema.Number),
  raw: Schema.optional(Schema.Boolean),
  hold: Schema.optional(Schema.Boolean),
});

export const Observations = Schema.Record(Schema.String, Schema.Number);

class MetaforgeState extends Cloudflare.DurableObject<MetaforgeState>()(
  "MetaforgeFixtureState",
  Effect.gen(function* () {
    const { storage } = yield* Cloudflare.DurableObjectState;

    return Effect.sync(() => {
      const gates = new Map<string, Deferred.Deferred<void>>();

      return {
        configure: Effect.fnUntraced(function* (
          control: typeof SourceControl.Type,
        ) {
          if (control.hold)
            gates.set(control.key, yield* Deferred.make<void>());
          yield* storage.put(`control:${control.key}`, control);
        }),
        release: Effect.fnUntraced(function* (key: string) {
          const gate = gates.get(key);

          if (gate !== undefined) {
            yield* Deferred.succeed(gate, undefined);
            gates.delete(key);
          }
        }),
        observations: Effect.fnUntraced(function* () {
          return Object.fromEntries(
            [...(yield* storage.list<number>({ prefix: "calls:" }))].map(
              ([key, value]) => [key.slice(6), value],
            ),
          );
        }),
        request: Effect.fnUntraced(function* (key: string) {
          const control = yield* storage.get<typeof SourceControl.Type>(
            `control:${key}`,
          );

          yield* storage
            .transaction(
              Effect.gen(function* () {
                yield* storage.put(
                  `calls:${key}`,
                  ((yield* storage.get<number>(`calls:${key}`)) ?? 0) + 1,
                );
              }),
            )
            .pipe(Effect.orDie);
          const gate = gates.get(key);

          if (control?.hold && gate !== undefined) yield* Deferred.await(gate);

          if (control?.delayMs) yield* Effect.sleep(control.delayMs);

          if (control !== undefined)
            return {
              status: control.status ?? 200,
              body: control.body,
              raw: control.raw ?? false,
            };

          return {
            status: 200,
            body: {
              data: [
                {
                  id: "sensors",
                  name: "Sensors",
                  value: 10,
                  workbench: null,
                  loot_area: "Industrial",
                  components: [],
                },
              ],
            },
            raw: false,
          };
        }),
      };
    });
  }),
) {}

class MetaforgeApi extends HttpApi.make("metaforge-fixture").add(
  HttpApiGroup.make("source").add(
    HttpApiEndpoint.get("items", "/items"),
    HttpApiEndpoint.get("arcs", "/arcs"),
    HttpApiEndpoint.get("traders", "/traders"),
    HttpApiEndpoint.get("events", "/events-schedule"),
    HttpApiEndpoint.post("control", "/control"),
    HttpApiEndpoint.post("release", "/release"),
    HttpApiEndpoint.get("observations", "/observations"),
  ),
) {}

export class MetaforgeWorker extends Cloudflare.Worker<MetaforgeWorker>()(
  "MetaforgeFixture",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-metaforge-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const objects = yield* MetaforgeState;
    const source = () => objects.getByName("source");

    const handler = Effect.fnUntraced(function* (url: string) {
      const parsed = new URL(url, "https://fixture.invalid");
      parsed.searchParams.sort();

      const result = yield* source().request(
        `${parsed.pathname}${parsed.search}`,
      );

      return result.raw
        ? HttpServerResponse.text(String(result.body), {
            status: result.status,
          })
        : HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
    });

    const handlers = HttpApiBuilder.group(MetaforgeApi, "source", (handlers) =>
      handlers
        .handleRaw("items", ({ request }) => handler(request.url))
        .handleRaw("arcs", ({ request }) => handler(request.url))
        .handleRaw("traders", ({ request }) => handler(request.url))
        .handleRaw("events", ({ request }) => handler(request.url))
        .handleRaw("control", ({ request }) =>
          Effect.gen(function* () {
            const control = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SourceControl)),
              Effect.orDie,
            );

            yield* source().configure(control);

            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("release", ({ request }) =>
          Effect.gen(function* () {
            const key = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
              Effect.orDie,
            );

            yield* source().release(key);

            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("observations", () =>
          source()
            .observations()
            .pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(MetaforgeApi).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          handler.pipe(Effect.map(identifyFixtureResponse)),
        ),
      ),
    };
  }),
) {}

export default MetaforgeWorker;
