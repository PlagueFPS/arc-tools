import { Schema, Effect, Layer, Semaphore } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  type CacheStorage,
  dataFromReader,
  Cache,
  cacheLayer,
} from "../src/cache.js";
import { ArcData } from "../src/data-service.js";
import type { CachePolicy } from "../src/source.js";

export function memoryStorage() {
  const rows = new Map<string, unknown>();
  const mutex = Semaphore.makeUnsafe(1);

  const storage: CacheStorage = {
    get: (key) => Effect.sync(() => structuredClone(rows.get(key))),
    put: (key, value) =>
      Effect.sync(() => {
        rows.set(key, structuredClone(value));
      }),
    remove: (key) =>
      Effect.sync(() => {
        rows.delete(key);
      }),
    entries: () =>
      Effect.sync(
        () =>
          new Map(
            [...rows].flatMap(([key, value]) =>
              key.startsWith("entry:")
                ? [[key, structuredClone(value)] as const]
                : [],
            ),
          ),
      ),
    transaction: (effect) => mutex.withPermit(effect),
  };

  return storage;
}

export const makeFixture = Effect.fnUntraced(function* (
  options: { policy?: CachePolicy } = {},
) {
  const storage = memoryStorage();
  const calls: string[] = [];

  let respond = (_url: URL): Effect.Effect<Response, Error> =>
    Effect.succeed(
      Response.json({ data: [{ id: "sensors", name: "Sensors", value: 10 }] }),
    );

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      calls.push(url.toString());

      return respond(url).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        ),
      );
    }),
  );

  const reconstruct = Cache.pipe(
    Effect.provide(cacheLayer(storage, options)),
  ).pipe(Effect.provide(http));

  const cache = yield* reconstruct;

  return {
    cache,
    storage,
    calls,
    reconstruct,
    data: dataFromReader(cache.read),
    layer: Layer.succeed(ArcData, dataFromReader(cache.read)),
    respond: (handler: typeof respond) => {
      respond = handler;
    },
    body: (body: Schema.Json, status = 200) => {
      respond = () => Effect.succeed(Response.json(body, { status }));
    },
  };
});
