/* oxlint-disable effecttsgo/crypto-random-uuid -- Native fixture callbacks allocate secure operation IDs synchronously. */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import {
  Deferred,
  Effect,
  Result,
  Layer,
  Schema,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import type { AttributionStorage } from "./alarm-attribution.js";
import { ControlId, fixtureControl } from "./fixture-control.js";
import { identifyFixtureResponse } from "./fixture-response.js";
import { CurrentJourney, routeJourney } from "./fixture-routing.js";

export const SourceControl = Schema.Struct({
  key: Schema.String,
  status: Schema.optional(Schema.Int),
  body: Schema.Json,
  delayMs: Schema.optional(Schema.Finite),
  raw: Schema.optional(Schema.Boolean),
});

export const Observations = Schema.Record(Schema.String, Schema.Finite);

const Activation = Schema.Struct({ id: ControlId, patch: SourceControl });

const Retirement = Schema.Struct({ id: ControlId });

type HeldSource = {
  input: typeof SourceControl.Type;
  seedVersion: string | null;
} | null;

export const makeSourceFixture = Effect.fnUntraced(function* (
  storage: AttributionStorage & {
    readonly list: <T = unknown>(options: {
      prefix: string;
    }) => Effect.Effect<
      Map<string, T>,
      never,
      import("alchemy/RuntimeContext").RuntimeContext
    >;
  },
) {
  const temporary = yield* fixtureControl<HeldSource>(
    storage,
    null,
    (setting) => (setting ? [setting.input.key] : []),
  );

  return {
    configure: (control: typeof SourceControl.Type) =>
      storage.put(`control:${control.key}`, {
        input: control,
        version: crypto.randomUUID(),
      }),
    activate: Effect.fnUntraced(function* (input: typeof Activation.Type) {
      const seed = yield* storage.get<{ version: string }>(
        `control:${input.patch.key}`,
      );

      yield* temporary.activate(input.id, {
        input: input.patch,
        seedVersion: seed?.version ?? null,
      });
    }),
    retire: (id: string) => temporary.retire(id),
    controlState: (id: string) => temporary.observe(id),
    observations: Effect.fnUntraced(function* () {
      return EffectRecord.fromEntries(
        EffectArray.map(
          [...(yield* storage.list<number>({ prefix: "calls:" }))],
          ([key, value]) => [EffectString.slice(6)(key), value],
        ),
      );
    }),
    request: Effect.fnUntraced(function* (key: string) {
      const captured = yield* temporary.capture;

      const seed = yield* storage.get<{
        input: typeof SourceControl.Type;
        version: string;
      }>(`control:${key}`);

      const held =
        captured.settings?.input.key === key &&
        (seed?.version ?? null) === captured.settings.seedVersion;

      const control = held ? captured.settings?.input : seed?.input;
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
      const gate = held ? captured.gates.get(key) : undefined;

      if (gate) yield* Deferred.await(gate);

      if (control?.delayMs) yield* Effect.sleep(control.delayMs);

      return control
        ? {
            status: control.status ?? 200,
            body: control.body,
            raw: control.raw ?? false,
          }
        : {
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

class MetaforgeState extends Cloudflare.DurableObject<MetaforgeState>()(
  "MetaforgeFixtureState",
  Effect.gen(function* () {
    const { storage } = yield* Cloudflare.DurableObjectState;

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
    return makeSourceFixture(storage);
  }),
) {}

class MetaforgeApi extends HttpApi.make("metaforge-fixture").add(
  HttpApiGroup.make("source").add(
    HttpApiEndpoint.get("items", "/items"),
    HttpApiEndpoint.get("arcs", "/arcs"),
    HttpApiEndpoint.get("traders", "/traders"),
    HttpApiEndpoint.get("events", "/events-schedule"),
    HttpApiEndpoint.post("control", "/control"),
    HttpApiEndpoint.post("activate", "/temporary/activate"),
    HttpApiEndpoint.post("retire", "/temporary/retire"),
    HttpApiEndpoint.get("controlState", "/temporary/state"),
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

    const source = <A, E, R>(
      use: (
        object: ReturnType<typeof objects.getByName>,
      ) => Effect.Effect<A, E, R>,
    ) =>
      CurrentJourney.pipe(
        Effect.flatMap((journey) =>
          use(objects.getByName("source:" + journey)),
        ),
      );

    const handler = Effect.fnUntraced(function* (url: string) {
      const parsed = new URL(url, "https://fixture.invalid");
      parsed.searchParams.sort();

      const result = yield* source((object) =>
        object.request(`${parsed.pathname}${parsed.search}`),
      );

      return result.raw
        ? HttpServerResponse.text(
            yield* Schema.decodeUnknownEffect(Schema.String)(result.body).pipe(
              Effect.orDie,
            ),
            {
              status: result.status,
            },
          )
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

            yield* source((object) => object.configure(control));

            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("activate", ({ request }) =>
          Effect.gen(function* () {
            const input = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Activation)),
              Effect.orDie,
            );

            const result = yield* source((object) =>
              object.activate(input),
            ).pipe(Effect.result);

            return HttpServerResponse.empty({
              status: Result.isSuccess(result) ? 204 : 409,
            });
          }),
        )
        .handleRaw("retire", ({ request }) =>
          Effect.gen(function* () {
            const input = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Retirement)),
              Effect.orDie,
            );

            yield* source((object) => object.retire(input.id));

            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("controlState", ({ request }) =>
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(ControlId)(
              new URL(request.url, "https://fixture.invalid").searchParams.get(
                "id",
              ),
            ).pipe(Effect.orDie);

            return yield* source((object) => object.controlState(id)).pipe(
              Effect.map(HttpServerResponse.jsonUnsafe),
            );
          }),
        )
        .handleRaw("observations", () =>
          source((object) => object.observations()).pipe(
            Effect.map(HttpServerResponse.jsonUnsafe),
          ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(MetaforgeApi).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
        Effect.flatten,
        routeJourney,
        Effect.map(identifyFixtureResponse),
      ),
    };
  }),
) {}

export default MetaforgeWorker;
