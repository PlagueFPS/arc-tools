import * as Cloudflare from "alchemy/Cloudflare";
import { DurableObjectStorageError } from "alchemy/Cloudflare/Workers/DurableObjectStorage";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  type CacheStorage,
  dataFromReader,
  EncodedRead,
  makeCache,
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
    entries: () => provide(storage.list({ prefix: "entry:" })),
    transaction: (effect) =>
      provide(storage.transaction(effect)).pipe(
        Effect.catchIf(
          (error) => error instanceof DurableObjectStorageError,
          Effect.die,
        ),
      ),
  } satisfies CacheStorage;
});

const CacheReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), result: EncodedRead }),
  Schema.Struct({ kind: Schema.Literal("failure"), error: DataUnavailable }),
]);
export const makeCacheRpc = Effect.fnUntraced(function* (
  options: Parameters<typeof makeCache>[1] = {},
) {
  const storage = yield* makeDurableStorage;
  const cache = yield* makeCache(storage, options).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  const read = Effect.fn("ArcCache.rpc")(function* (query: ResourceQuery) {
    return yield* cache.read(query).pipe(
      Effect.match({
        onSuccess: (result) => ({ kind: "success", result }) as const,
        onFailure: (error) => ({ kind: "failure", error }) as const,
      }),
      Effect.flatMap(Schema.encodeEffect(CacheReply)),
      Effect.orDie,
    );
  });
  return { read, reset: cache.reset };
});

export class ArcCacheDO extends Cloudflare.DurableObject<ArcCacheDO>()(
  "ArcCache",
  Effect.succeed(
    Effect.gen(function* () {
      const cache = yield* makeCacheRpc();
      return { read: cache.read };
    }),
  ),
) {}

export const layer = Layer.effect(
  ArcData,
  Effect.gen(function* () {
    const objects = yield* ArcCacheDO;
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
        const reply = yield* Schema.decodeUnknownEffect(CacheReply)(raw).pipe(
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
  }),
);
