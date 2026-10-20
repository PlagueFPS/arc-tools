import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { CacheRow } from "../../packages/arc-data/src/cache.js";
import {
  CacheRpc,
  cacheRpcLayer,
} from "../../packages/arc-data/src/cloudflare.js";
import { ResourceQuery } from "../../packages/arc-data/src/data-service.js";
import { cachePolicy } from "../../packages/arc-data/src/source.js";
import {
  acknowledgeReconstruction,
  identifyFixtureResponse,
} from "./fixture-response.js";
import { MetaforgeWorker } from "./metaforge.js";

export const CacheSnapshot = Schema.Struct({
  instance: Schema.String,
  rows: Schema.Record(Schema.String, CacheRow),
});

export class CacheFixtureObject extends Cloudflare.DurableObject<CacheFixtureObject>()(
  "CacheFixture",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const source = yield* Cloudflare.Worker(MetaforgeWorker.LogicalId, {});
    const sourceUrl = yield* source.url;

    return Effect.gen(function* () {
      const instance = crypto.randomUUID();
      const baseUrl = yield* sourceUrl;

      if (!Schema.is(Schema.String)(baseUrl))
        return yield* Effect.die("Metaforge fixture URL is unavailable");

      const options = {
        baseUrl,
        policy: { ...cachePolicy, sourceTimeoutMs: 15_000 },
      };

      let cache = yield* CacheRpc.pipe(Effect.provide(cacheRpcLayer(options)));
      const clock = yield* Clock.Clock;

      const read = Effect.fnUntraced(function* (query: ResourceQuery) {
        const time = yield* state.storage.get<number>("fixtureTime");

        if (time === undefined) return yield* cache.read(query);

        return yield* cache.read(query).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.succeed(time),
            currentTimeMillisUnsafe: () => time,
            currentTimeNanos: Effect.succeed(BigInt(time) * 1_000_000n),
            currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          }),
        );
      });

      return {
        read,
        time: (time: number) => state.storage.put("fixtureTime", time),
        clear: Effect.fnUntraced(function* () {
          yield* cache.reset;
          cache = yield* CacheRpc.pipe(
            Effect.provide(cacheRpcLayer(options)),
          ).pipe(Effect.provideService(Cloudflare.DurableObjectState, state));
        }),
        snapshot: Effect.fnUntraced(function* () {
          return {
            instance,
            rows: Object.fromEntries(
              yield* state.storage.list({ prefix: "entry:" }),
            ),
          };
        }),
        reconstruct: Effect.fnUntraced(function* () {
          yield* state.storage.sync();
          yield* state.abort("cache reconstruction fixture");
        }),
      };
    });
  }),
) {}

class CacheApi extends HttpApi.make("cache-fixture").add(
  HttpApiGroup.make("cache").add(
    HttpApiEndpoint.post("read", "/read"),
    HttpApiEndpoint.post("time", "/time"),
    HttpApiEndpoint.post("clear", "/clear"),
    HttpApiEndpoint.post("reconstruct", "/reconstruct"),
    HttpApiEndpoint.get("snapshot", "/snapshot"),
  ),
) {}

export class CacheFixtureWorker extends Cloudflare.Worker<CacheFixtureWorker>()(
  "CacheFixtureWorker",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-cache-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const objects = yield* CacheFixtureObject;
    const object = () => objects.getByName("environment");

    const handlers = HttpApiBuilder.group(CacheApi, "cache", (handlers) =>
      handlers
        .handleRaw("read", ({ request }) =>
          Effect.gen(function* () {
            const query = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ResourceQuery)),
              Effect.orDie,
            );

            return yield* object()
              .read(query)
              .pipe(
                Effect.map(HttpServerResponse.jsonUnsafe),
                Effect.catchCause((cause) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      { fixtureError: Cause.pretty(cause) },
                      { status: 500 },
                    ),
                  ),
                ),
              );
          }),
        )
        .handleRaw("time", ({ request }) =>
          Effect.gen(function* () {
            const time = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Number)),
              Effect.orDie,
            );

            yield* object().time(time);

            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("clear", () =>
          object()
            .clear()
            .pipe(Effect.as(HttpServerResponse.empty({ status: 204 }))),
        )
        .handleRaw("reconstruct", () =>
          acknowledgeReconstruction(
            object().reconstruct(),
            "cache reconstruction fixture",
          ),
        )
        .handleRaw("snapshot", () =>
          object()
            .snapshot()
            .pipe(
              Effect.map(HttpServerResponse.jsonUnsafe),
              Effect.catchCause((cause) =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { fixtureError: Cause.pretty(cause) },
                    { status: 500 },
                  ),
                ),
              ),
            ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(CacheApi).pipe(
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

export default CacheFixtureWorker;
