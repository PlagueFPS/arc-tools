import { BASE_API_URL } from "@arctools/utils";
import { Clock, Effect, Predicate, Schema, SchemaIssue, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  ArcData,
  DataUnavailable,
  type ResourceQuery,
} from "./data-service.js";
import {
  ArcsAPIResponse,
  EventAPIResponse,
  ItemAPIResponse,
  TradersAPIResponse,
} from "./schema.js";

export const cachePolicy = {
  metadataFreshMs: 86_400_000,
  metadataFallbackMs: 604_800_000,
  scheduleFreshMs: 60_000,
  retryCooldownMs: 60_000,
  sourceTimeoutMs: 1_800,
  maxKeys: 128,
  maxEntryBytes: 96 * 1024,
  maxCacheBytes: 4 * 1024 * 1024,
  maxBodyBytes: 1024 * 1024,
} as const;
export type CachePolicy = { readonly [K in keyof typeof cachePolicy]: number };

export function canonicalRequest(query: ResourceQuery) {
  const params = new URLSearchParams();
  if (query.resource === "items" || query.resource === "arcs") {
    for (const [key, value] of Object.entries(query.params).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (Predicate.isNotUndefined(value)) params.set(key, String(value));
    }
  }
  const suffix = params.size ? `?${params}` : "";
  return `/${query.resource}${suffix}`;
}
export const cacheKey = (query: ResourceQuery) =>
  `v1:json:${canonicalRequest(query)}`;

export const makeSource = Effect.fnUntraced(function* (
  options: { readonly baseUrl?: string; readonly policy?: CachePolicy } = {},
) {
  const policy = options.policy ?? cachePolicy;
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(options.baseUrl ?? BASE_API_URL),
        HttpClientRequest.acceptJson,
      ),
    ),
    HttpClient.filterStatusOk,
  );
  const fetch = Effect.fn("ArcData.source")(
    function* <A, I>(query: ResourceQuery, schema: Schema.Codec<A, I>) {
      const path = canonicalRequest(query);
      const response = yield* client.get(path);
      let size = 0;
      const chunks: Uint8Array[] = [];
      yield* response.stream.pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (chunk) {
            size += chunk.byteLength;
            if (size > policy.maxBodyBytes)
              return yield* new DataUnavailable({
                resource: query.resource,
                reason: "source",
              });
            chunks.push(chunk);
          }),
        ),
      );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        new TextDecoder().decode(bytes),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Metaforge schema failure").pipe(
            Effect.annotateLogs({
              resource: query.resource,
              paths: SchemaIssue.makeFormatterStandardSchemaV1()(
                error.issue,
              ).issues.map((issue) => issue.path),
            }),
          ),
        ),
      );
    },
    (effect, query) =>
      effect.pipe(
        Effect.timeout(policy.sourceTimeoutMs),
        Effect.mapError(
          () =>
            new DataUnavailable({ resource: query.resource, reason: "source" }),
        ),
      ),
  );
  return { fetch };
});

export const makeUncachedData = Effect.gen(function* () {
  const source = yield* makeSource();
  const read = Effect.fnUntraced(function* <A, I>(
    query: ResourceQuery,
    schema: Schema.Codec<A, I>,
  ) {
    const response = yield* source.fetch(query, schema);
    return {
      value: response,
      provenance: {
        freshness: "fresh" as const,
        fetchedAt: yield* Clock.currentTimeMillis,
      },
    };
  });
  return ArcData.of({
    items: Effect.fnUntraced(function* (params) {
      const result = yield* read(
        { resource: "items", params },
        ItemAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
    arcs: Effect.fnUntraced(function* (params) {
      const result = yield* read(
        { resource: "arcs", params: { includeLoot: true, ...params } },
        ArcsAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
    traders: Effect.fnUntraced(function* () {
      const result = yield* read({ resource: "traders" }, TradersAPIResponse);
      return { ...result, value: result.value.data };
    }),
    events: Effect.fnUntraced(function* () {
      const result = yield* read(
        { resource: "events-schedule" },
        EventAPIResponse,
      );
      return { ...result, value: result.value.data };
    }),
  });
});
