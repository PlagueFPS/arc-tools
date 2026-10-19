import { Clock, Effect, Layer, Predicate, Schema, Semaphore } from "effect";
import {
  ArcData,
  DataUnavailable,
  Provenance,
  ResourceQuery,
} from "./data-service.js";
import {
  ArcsAPIResponse,
  EventAPIResponse,
  ItemAPIResponse,
  TradersAPIResponse,
} from "./schema.js";
import {
  type CachePolicy,
  cacheKey,
  cachePolicy,
  makeSource,
  makeUncachedData,
} from "./source.js";

export interface CacheStorage {
  readonly get: (key: string) => Effect.Effect<unknown>;
  readonly put: (key: string, value: unknown) => Effect.Effect<void>;
  readonly remove: (key: string) => Effect.Effect<void>;
  readonly entries: () => Effect.Effect<Map<string, unknown>>;
  readonly transaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}
const Value = Schema.Struct({
  body: Schema.String,
  bytes: Schema.Number,
  fetchedAt: Schema.Number,
});
export const CacheRow = Schema.Struct({
  generation: Schema.Number,
  schedule: Schema.Boolean,
  value: Schema.NullOr(Value),
  retryAt: Schema.Number,
  leaseUntil: Schema.Number,
});
type CacheRow = typeof CacheRow.Type;
export const EncodedRead = Schema.Struct({
  body: Schema.String,
  provenance: Provenance,
});
export type EncodedRead = typeof EncodedRead.Type;
const prefix = "entry:";
const decodeRow = Schema.decodeUnknownEffect(CacheRow);
const rowAt = Effect.fnUntraced(function* (storage: CacheStorage, key: string) {
  const row = yield* storage.get(key);
  return Predicate.isUndefined(row)
    ? undefined
    : yield* decodeRow(row).pipe(Effect.orDie);
});
const usable = (row: CacheRow, now: number, policy: CachePolicy) =>
  Predicate.isNotNull(row.value) &&
  now - row.value.fetchedAt <=
    (row.schedule ? policy.scheduleFreshMs - 1 : policy.metadataFallbackMs);
const fallback = (
  row: CacheRow,
  now: number,
  policy: CachePolicy,
): EncodedRead | undefined =>
  !row.schedule && Predicate.isNotNull(row.value) && usable(row, now, policy)
    ? {
        body: row.value.body,
        provenance: { freshness: "fallback", fetchedAt: row.value.fetchedAt },
      }
    : undefined;

export const makeCache = Effect.fnUntraced(function* (
  storage: CacheStorage,
  options: {
    readonly baseUrl?: string;
    readonly policy?: CachePolicy;
  } = {},
) {
  const policy = options.policy ?? cachePolicy;
  const source = yield* makeSource(options);
  const locks = new Map<
    string,
    { semaphore: Semaphore.Semaphore; users: number }
  >();
  const fetchEncoded = Effect.fnUntraced(function* <A, I>(
    query: ResourceQuery,
    schema: Schema.Codec<A, I>,
  ) {
    const value = yield* source.fetch(query, schema);
    const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError(
        () =>
          new DataUnavailable({ resource: query.resource, reason: "source" }),
      ),
    );
    return JSON.stringify(encoded);
  });
  const fetch = (query: ResourceQuery) => {
    switch (query.resource) {
      case "items":
        return fetchEncoded(query, ItemAPIResponse);
      case "arcs":
        return fetchEncoded(query, ArcsAPIResponse);
      case "traders":
        return fetchEncoded(query, TradersAPIResponse);
      case "events-schedule":
        return fetchEncoded(query, EventAPIResponse);
    }
  };
  const read = Effect.fn("ArcCache.read")(function* (input: ResourceQuery) {
    const query = yield* Schema.decodeUnknownEffect(ResourceQuery)(input).pipe(
      Effect.mapError(
        () =>
          new DataUnavailable({ resource: input.resource, reason: "query" }),
      ),
    );
    const key = `${prefix}${cacheKey(query)}`;
    if (new TextEncoder().encode(key).byteLength > 2048) {
      return yield* new DataUnavailable({
        resource: query.resource,
        reason: "query",
      });
    }
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        let lock = locks.get(key);
        if (Predicate.isUndefined(lock)) {
          lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, lock);
        }
        lock.users++;
        return lock;
      }),
      (lock) =>
        lock.semaphore.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const claim = yield* storage.transaction(
              Effect.gen(function* () {
                const row = yield* rowAt(storage, key);
                if (Predicate.isNotNullish(row?.value)) {
                  const age = now - row.value.fetchedAt;
                  if (
                    age <
                    (row.schedule
                      ? policy.scheduleFreshMs
                      : policy.metadataFreshMs)
                  ) {
                    return {
                      kind: "ready",
                      result: {
                        body: row.value.body,
                        provenance: {
                          freshness: "fresh",
                          fetchedAt: row.value.fetchedAt,
                        },
                      },
                    } as const;
                  }
                }
                if (
                  Predicate.isNotUndefined(row) &&
                  (row.retryAt > now || row.leaseUntil > now)
                ) {
                  const cached = fallback(row, now, policy);
                  if (Predicate.isNotUndefined(cached))
                    return { kind: "ready", result: cached } as const;
                  return yield* new DataUnavailable({
                    resource: query.resource,
                    reason: row.leaseUntil > now ? "refreshing" : "source",
                  });
                }
                const entries = yield* storage.entries();
                let count = entries.size;
                for (const [entryKey, raw] of entries) {
                  if (entryKey === key) continue;
                  const entry = yield* decodeRow(raw).pipe(Effect.orDie);
                  if (
                    !usable(entry, now, policy) &&
                    entry.retryAt <= now &&
                    entry.leaseUntil <= now
                  ) {
                    yield* storage.remove(entryKey);
                    count--;
                  }
                }
                if (Predicate.isUndefined(row) && count >= policy.maxKeys) {
                  return yield* new DataUnavailable({
                    resource: query.resource,
                    reason: "capacity",
                  });
                }
                const previous = yield* storage.get("generation");
                const generation =
                  (yield* Schema.decodeUnknownEffect(Schema.Number)(
                    previous ?? 0,
                  ).pipe(Effect.orDie)) + 1;
                yield* storage.put("generation", generation);
                yield* storage.put(key, {
                  generation,
                  schedule: query.resource === "events-schedule",
                  value: row?.value ?? null,
                  retryAt: 0,
                  leaseUntil: now + policy.sourceTimeoutMs + 1_000,
                } satisfies CacheRow);
                return { kind: "fetch", generation } as const;
              }),
            );
            if (claim.kind === "ready") return claim.result;
            const response = yield* fetch(query).pipe(Effect.result);
            const completedAt = yield* Clock.currentTimeMillis;
            const completion = yield* storage.transaction(
              Effect.gen(function* () {
                const current = yield* rowAt(storage, key);
                if (
                  Predicate.isUndefined(current) ||
                  current.generation !== claim.generation
                ) {
                  return new DataUnavailable({
                    resource: query.resource,
                    reason: "superseded",
                  });
                }
                let body: string | undefined;
                if (response._tag === "Success") body = response.success;
                if (Predicate.isNotUndefined(body)) {
                  const bytes = new TextEncoder().encode(body).byteLength;
                  const entries = yield* storage.entries();
                  let total = bytes;
                  for (const [entryKey, raw] of entries) {
                    if (entryKey === key) continue;
                    const entry = yield* decodeRow(raw).pipe(Effect.orDie);
                    total += entry.value?.bytes ?? 0;
                  }
                  if (
                    bytes <= policy.maxEntryBytes &&
                    total <= policy.maxCacheBytes
                  ) {
                    yield* storage.put(key, {
                      ...current,
                      value: { body, bytes, fetchedAt: completedAt },
                      retryAt: 0,
                      leaseUntil: 0,
                    });
                    return {
                      body,
                      provenance: {
                        freshness: "fresh",
                        fetchedAt: completedAt,
                      },
                    } as const;
                  }
                }
                yield* storage.put(key, {
                  ...current,
                  retryAt: completedAt + policy.retryCooldownMs,
                  leaseUntil: 0,
                });
                const cached = fallback(current, completedAt, policy);
                if (Predicate.isNotUndefined(cached)) return cached;
                return new DataUnavailable({
                  resource: query.resource,
                  reason: "source",
                });
              }),
            );
            if (completion instanceof DataUnavailable) return yield* completion;
            return completion;
          }),
        ),
      (lock) =>
        Effect.sync(() => {
          lock.users--;
          if (lock.users === 0) locks.delete(key);
        }),
    );
  });
  const reset = storage.transaction(
    Effect.gen(function* () {
      for (const key of (yield* storage.entries()).keys())
        yield* storage.remove(key);
    }),
  );
  return { read, reset };
});

export const dataFromReader = (
  read: (query: ResourceQuery) => Effect.Effect<EncodedRead, DataUnavailable>,
) => {
  const decode = Effect.fnUntraced(function* <A, I>(
    query: ResourceQuery,
    schema: Schema.Codec<A, I>,
  ) {
    const result = yield* read(query);
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(schema),
    )(result.body).pipe(
      Effect.mapError(
        () =>
          new DataUnavailable({ resource: query.resource, reason: "source" }),
      ),
    );
    return { value, provenance: result.provenance };
  });
  return ArcData.of({
    items: Effect.fnUntraced(function* (params) {
      const result = yield* decode(
        { resource: "items", params },
        ItemAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
    arcs: Effect.fnUntraced(function* (params) {
      const result = yield* decode(
        { resource: "arcs", params: { includeLoot: true, ...params } },
        ArcsAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
    traders: Effect.fnUntraced(function* () {
      const result = yield* decode({ resource: "traders" }, TradersAPIResponse);
      return { ...result, value: result.value.data };
    }),
    events: Effect.fnUntraced(function* () {
      const result = yield* decode(
        { resource: "events-schedule" },
        EventAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
  });
};
export const layerUncached = Layer.effect(ArcData, makeUncachedData);
