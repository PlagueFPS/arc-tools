import { BASE_API_URL } from "@arctools/utils";
import {
  Layer,
  Context,
  Clock,
  Effect,
  Predicate,
  Schema,
  SchemaIssue,
  Stream,
  Array as Arr,
  Record as Rec,
  String as Str,
} from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from "effect/http";

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

type SourceBodyError = HttpClientError.HttpClientError | DataUnavailable;

export function canonicalRequest(query: ResourceQuery) {
  const params = new URLSearchParams();

  if (query.resource === "items" || query.resource === "arcs") {
    for (const [key, value] of Rec.toEntries<
      string,
      string | number | boolean | undefined
    >(query.params).sort(([a], [b]) => Str.localeCompare(b)(a))) {
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
    HttpClient.withScope,
  );

  const fetch = Effect.fn("ArcData.source")(
    function* <A, I>(query: ResourceQuery, schema: Schema.Codec<A, I>) {
      const path = canonicalRequest(query);
      const response = yield* client.get(path);

      const bytes = yield* response.stream.pipe(
        Stream.limitBytes<SourceBodyError, never>(policy.maxBodyBytes, () =>
          Stream.fail(
            new DataUnavailable({
              resource: query.resource,
              reason: "source",
            }),
          ),
        ),
        Stream.mkUint8Array,
      );

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
        new TextDecoder().decode(bytes),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Metaforge schema failure").pipe(
            Effect.annotateLogs({
              resource: query.resource,
              paths: Arr.map(
                SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
                (issue) => issue.path,
              ),
            }),
          ),
        ),
      );
    },
    (effect, query) =>
      effect.pipe(
        Effect.scoped,
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
    traders: Effect.gen(function* () {
      const result = yield* read({ resource: "traders" }, TradersAPIResponse);

      return { ...result, value: result.value.data };
    }),
    events: Effect.gen(function* () {
      const result = yield* read(
        { resource: "events-schedule" },
        EventAPIResponse,
      );

      return { ...result, value: result.value.data };
    }),
  });
});

export class Source extends Context.Service<
  Source,
  Effect.Success<ReturnType<typeof makeSource>>
>()("@arctools/Source") {}

export const sourceLayer = (options: Parameters<typeof makeSource>[0] = {}) =>
  Layer.effect(Source, makeSource(options));

export const layerUncached = Layer.effect(ArcData, makeUncachedData);
