/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import {
  Schema,
  Effect,
  Layer,
  Semaphore,
  Array as EffectArray,
  String as EffectString,
} from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  type CacheStorage,
  dataFromReader,
  Cache,
  cacheLayer,
} from "../src/cache.js";
import { ArcData } from "../src/data-service.js";
import type { CachePolicy } from "../src/source.js";

export class SourceFailure extends Schema.TaggedError<
  SourceFailure,
  { readonly brand: unique symbol }
>()("SourceFailure", { message: Schema.String }) {}

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
    entries: Effect.sync(
      () =>
        new Map(
          EffectArray.flatMap([...rows], ([key, value]) =>
            EffectString.startsWith("entry:")(key)
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

  let respond = (_url: URL): Effect.Effect<Response, SourceFailure> =>
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
    Effect.provide(cacheLayer(storage, options).pipe(Layer.provide(http))),
  );

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
