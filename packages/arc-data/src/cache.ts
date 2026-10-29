import {
  Context,
  Clock,
  Effect,
  Layer,
  Match,
  Option,
  Result,
  Predicate,
  Schema,
  Semaphore,
} from "effect";

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
  Source,
  sourceLayer,
} from "./source.js";

export interface CacheStorage {
  readonly get: (key: string) => Effect.Effect<unknown>;
  readonly put: (key: string, value: CacheRow | number) => Effect.Effect<void>;
  readonly remove: (key: string) => Effect.Effect<void>;
  readonly entries: Effect.Effect<Map<string, unknown>>;
  readonly transaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

const Value = Schema.Struct({
  body: Schema.String,
  bytes: Schema.Finite,
  fetchedAt: Schema.Finite,
});

export const CacheRow = Schema.Struct({
  generation: Schema.Finite,
  schedule: Schema.Boolean,
  value: Schema.NullOr(Value),
  retryAt: Schema.Finite,
  leaseUntil: Schema.Finite,
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
    ? Option.none<CacheRow>()
    : Option.some(yield* decodeRow(row).pipe(Effect.orDie));
});

const usable = (row: CacheRow, now: number, policy: CachePolicy) =>
  Predicate.isNotNull(row.value) &&
  now - row.value.fetchedAt <=
    (row.schedule ? policy.scheduleFreshMs - 1 : policy.metadataFallbackMs);

const fallback = (
  row: CacheRow,
  now: number,
  policy: CachePolicy,
): Option.Option<EncodedRead> =>
  !row.schedule && Predicate.isNotNull(row.value) && usable(row, now, policy)
    ? Option.some({
        body: row.value.body,
        provenance: { freshness: "fallback", fetchedAt: row.value.fetchedAt },
      })
    : Option.none();

export const makeCache = Effect.fnUntraced(function* (
  storage: CacheStorage,
  options: {
    readonly baseUrl?: string;
    readonly policy?: CachePolicy;
  } = {},
) {
  const policy = options.policy ?? cachePolicy;
  const source = yield* Source;

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

    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      encoded,
    ).pipe(Effect.orDie);
  });

  const fetch = (query: ResourceQuery) =>
    Match.value(query).pipe(
      Match.when({ resource: "items" }, (query) =>
        fetchEncoded(query, ItemAPIResponse),
      ),
      Match.when({ resource: "arcs" }, (query) =>
        fetchEncoded(query, ArcsAPIResponse),
      ),
      Match.when({ resource: "traders" }, (query) =>
        fetchEncoded(query, TradersAPIResponse),
      ),
      Match.when({ resource: "events-schedule" }, (query) =>
        fetchEncoded(query, EventAPIResponse),
      ),
      Match.exhaustive,
    );

  const read = Effect.fn("ArcCache.read")(function* (input: ResourceQuery) {
    const query = yield* Schema.decodeEffect(ResourceQuery)(input).pipe(
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

                if (
                  Option.isSome(row) &&
                  Predicate.isNotNull(row.value.value)
                ) {
                  const age = now - row.value.value.fetchedAt;

                  if (
                    age <
                    (row.value.schedule
                      ? policy.scheduleFreshMs
                      : policy.metadataFreshMs)
                  ) {
                    return {
                      kind: "ready",
                      result: {
                        body: row.value.value.body,
                        provenance: {
                          freshness: "fresh",
                          fetchedAt: row.value.value.fetchedAt,
                        },
                      },
                    } as const;
                  }
                }

                if (
                  Option.isSome(row) &&
                  (row.value.retryAt > now || row.value.leaseUntil > now)
                ) {
                  const cached = fallback(row.value, now, policy);

                  if (Option.isSome(cached))
                    return { kind: "ready", result: cached.value } as const;

                  return yield* new DataUnavailable({
                    resource: query.resource,
                    reason:
                      row.value.leaseUntil > now ? "refreshing" : "source",
                  });
                }

                const entries = yield* storage.entries;
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

                if (Option.isNone(row) && count >= policy.maxKeys) {
                  return yield* new DataUnavailable({
                    resource: query.resource,
                    reason: "capacity",
                  });
                }

                const previous = yield* storage.get("generation");

                const generation =
                  (yield* Schema.decodeUnknownEffect(Schema.Finite)(
                    previous ?? 0,
                  ).pipe(Effect.orDie)) + 1;

                yield* storage.put("generation", generation);
                yield* storage.put(key, {
                  generation,
                  schedule: query.resource === "events-schedule",
                  value: Option.match(row, {
                    onNone: () => null,
                    onSome: (row) => row.value,
                  }),
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
                  Option.isNone(current) ||
                  current.value.generation !== claim.generation
                ) {
                  return new DataUnavailable({
                    resource: query.resource,
                    reason: "superseded",
                  });
                }

                if (Result.isSuccess(response)) {
                  const body = response.success;
                  const bytes = new TextEncoder().encode(body).byteLength;
                  const entries = yield* storage.entries;
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
                      ...current.value,
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
                  ...current.value,
                  retryAt: completedAt + policy.retryCooldownMs,
                  leaseUntil: 0,
                });
                const cached = fallback(current.value, completedAt, policy);

                if (Option.isSome(cached)) return cached.value;

                return new DataUnavailable({
                  resource: query.resource,
                  reason: "source",
                });
              }),
            );

            if (Schema.is(DataUnavailable)(completion))
              return yield* completion;

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
      for (const key of (yield* storage.entries).keys())
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

    const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      result.body,
    ).pipe(
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
    traders: Effect.gen(function* () {
      const result = yield* decode({ resource: "traders" }, TradersAPIResponse);

      return { ...result, value: result.value.data };
    }),
    events: Effect.gen(function* () {
      const result = yield* decode(
        { resource: "events-schedule" },
        EventAPIResponse,
      );

      return { ...result, value: result.value.data };
    }),
  });
};

export class Cache extends Context.Service<
  Cache,
  Effect.Success<ReturnType<typeof makeCache>>
>()("@arctools/Cache") {}

export const cacheLayer = (
  storage: CacheStorage,
  options: Parameters<typeof makeCache>[1] = {},
) =>
  Layer.effect(Cache, makeCache(storage, options)).pipe(
    Layer.provide(sourceLayer(options)),
  );
