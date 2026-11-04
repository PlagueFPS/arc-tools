/* oxlint-disable effecttsgo/strict-effect-provide -- These host adapters provide stateless Web Crypto services for callers outside a shared runtime. */
import {
  flow,
  Effect,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as Crypto from "./crypto.js";

export class ProviderError extends Schema.TaggedError<
  ProviderError,
  { readonly brand: unique symbol }
>()("ProviderError", {
  kind: Schema.Literals(["network", "body", "deadline"]),
}) {}

export const providerTransport = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, (effect) =>
      Effect.flatMap(
        Effect.serviceOption(FetchHttpClient.RequestInit),
        (init) =>
          Effect.provideService(effect, FetchHttpClient.RequestInit, {
            ...Option.getOrUndefined(init),
            redirect: "manual",
          }),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

export const request = Effect.fn("Provider.request")(function* <A, E, R>(
  client: HttpClient.HttpClient,
  outgoing: HttpClientRequest.HttpClientRequest,
  consume: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R | Scope.Scope>,
  timeoutMs = 4_000,
) {
  return yield* HttpClient.withScope(client)
    .execute(outgoing)
    .pipe(
      Effect.flatMap(consume),
      Effect.mapError((error) =>
        HttpClientError.isHttpClientError(error)
          ? new ProviderError({ kind: "network" })
          : error,
      ),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => new ProviderError({ kind: "network" }),
      }),
    );
});

export const readJson = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const bytes = yield* response.stream.pipe(
    Stream.catchReason("HttpClientError", "EmptyBodyError", () => Stream.empty),
    Stream.mapError(() => new ProviderError({ kind: "network" })),
    Stream.limitBytes(256 * 1024, () =>
      Stream.fail(new ProviderError({ kind: "network" })),
    ),
    Stream.mkUint8Array,
  );

  if (bytes.byteLength === 0) return null;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
    new TextDecoder().decode(bytes),
  ).pipe(Effect.mapError(() => new ProviderError({ kind: "network" })));
});

export const decodeBody = <A, I>(schema: Schema.Codec<A, I>) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(() => new ProviderError({ kind: "body" })),
  );

export const randomUUID = Crypto.randomUUID.pipe(
  Effect.provide(Crypto.cryptoLayer),
);

export const digest = (value: string) =>
  Crypto.digest(value).pipe(Effect.provide(Crypto.cryptoLayer));
