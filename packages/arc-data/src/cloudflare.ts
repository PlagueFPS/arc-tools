import * as Cloudflare from "@alchemy.run/cloudflare";
import type { DurableObjectStorageError } from "@alchemy.run/cloudflare/Workers/DurableObjectStorage";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { Suggestion, Suggestions } from "./autocomplete.js";
import {
  type CacheStorage,
  dataFromReader,
  EncodedRead,
  Cache,
  cacheLayer,
} from "./cache.js";
import {
  ArcData,
  DataUnavailable,
  type ResourceQuery,
} from "./data-service.js";

export const makeDurableStorage: Effect.Effect<
  CacheStorage,
  never,
  RuntimeContext | Cloudflare.DurableObjectState
> = Effect.gen(function* () {
  const { storage } = yield* Cloudflare.DurableObjectState;
  const runtime = yield* RuntimeContext;

  const provide = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
    effect.pipe(Effect.provideService(RuntimeContext, runtime));

  return {
    get: (key) => provide(storage.get(key)),
    put: (key, value) => provide(storage.put(key, value)),
    remove: (key) => provide(storage.delete(key)).pipe(Effect.asVoid),
    entries: provide(storage.list({ prefix: "entry:" })),
    transaction: (effect) =>
      provide(storage.transaction(effect)).pipe(
        Effect.catchIf(
          (error): error is DurableObjectStorageError =>
            Predicate.isTagged(error, "DurableObjectStorageError"),
          Effect.die,
        ),
      ),
  } satisfies CacheStorage;
});

const CacheReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), result: EncodedRead }),
  Schema.Struct({ kind: Schema.Literal("failure"), error: DataUnavailable }),
]);

export const makeRetainedCacheReader = (
  cache: Effect.Success<typeof Cache>,
  retain: (effect: Effect.Effect<void>) => Effect.Effect<void>,
) => {
  const pending = new Set<"items-catalog" | "arcs-catalog">();

  return Effect.fn("ArcCache.retainedRead")(function* (query: ResourceQuery) {
    const result = yield* cache.read(query);

    if (query.resource === "items" || query.resource === "arcs") {
      const resource = `${query.resource}-catalog` as const;

      if (!pending.has(resource)) {
        pending.add(resource);
        yield* retain(
          cache
            .read({ resource })
            .pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => pending.delete(resource))),
            ),
        );
      }
    }

    return result;
  });
};

export const makeCacheRpc = Effect.fnUntraced(function* (
  options: Parameters<typeof cacheLayer>[1] = {},
) {
  const storage = yield* makeDurableStorage;

  const cache = yield* Cache.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Worker or Durable Object adapter is the composition root for its runtime services.
    Effect.provide(
      cacheLayer(storage, options).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );

  const state = yield* Cloudflare.DurableObjectState;
  const runtime = yield* RuntimeContext;

  const retainedRead = makeRetainedCacheReader(cache, (effect) =>
    state
      .waitUntil(effect)
      .pipe(Effect.provideService(RuntimeContext, runtime)),
  );

  const read = Effect.fn("ArcCache.rpc")(function* (query: ResourceQuery) {
    return yield* retainedRead(query).pipe(
      Effect.match({
        onSuccess: (result) => ({ kind: "success", result }) as const,
        onFailure: (error) => ({ kind: "failure", error }) as const,
      }),
      Effect.flatMap(Schema.encodeEffect(CacheReply)),
      Effect.orDie,
    );
  });

  return { read, reset: cache.reset, suggest: cache.suggest };
});

export class CacheSource extends Context.Service<
  CacheSource,
  {
    readonly options: Effect.Effect<
      { readonly baseUrl: string },
      never,
      RuntimeContext
    >;
  }
>()("@arctools/CacheSource") {}

export class ArcCacheDO extends Cloudflare.DurableObject<ArcCacheDO>()(
  "ArcCache",
  Effect.gen(function* () {
    const source = yield* Effect.serviceOption(CacheSource);

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
    return Effect.gen(function* () {
      const options = Option.isSome(source) ? yield* source.value.options : {};
      const cache = yield* makeCacheRpc(options);

      return { read: cache.read, suggest: cache.suggest };
    });
  }),
) {}

export const bindData = Effect.gen(function* () {
  const objects = yield* ArcCacheDO;

  // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
  return Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const object = objects.getByName("environment");

    return dataFromReader(
      Effect.fn("ArcData.cached")(function* (query) {
        const raw = yield* object.read(query).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.mapError(
            () =>
              new DataUnavailable({
                resource: query.resource,
                reason: "source",
              }),
          ),
        );

        const reply = yield* Schema.decodeEffect(CacheReply)(raw).pipe(
          Effect.mapError(
            () =>
              new DataUnavailable({
                resource: query.resource,
                reason: "source",
              }),
          ),
        );

        if (reply.kind === "failure") return yield* reply.error;

        return reply.result;
      }),
    );
  });
});

export const layer = Layer.effect(ArcData, bindData.pipe(Effect.flatten));

export class CacheRpc extends Context.Service<
  CacheRpc,
  Effect.Success<ReturnType<typeof makeCacheRpc>>
>()("@arctools/CacheRpc") {}

export const cacheRpcLayer = (
  options: Parameters<typeof makeCacheRpc>[0] = {},
) => Layer.effect(CacheRpc, makeCacheRpc(options));

export const bindSuggestions = Effect.gen(function* () {
  const objects = yield* ArcCacheDO;

  // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy requires a deferred Effect from this first initialization or binding stage.
  return Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const object = objects.getByName("environment");

    return Suggestions.of({
      suggest: (kind, query) =>
        object.suggest(kind, query).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Suggestion).check(Schema.isMaxLength(25)),
            ),
          ),
          Effect.catchCause(() => Effect.succeed([])),
        ),
    });
  });
});
