import {
  flow,
  Crypto,
  Effect,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

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

const webCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.promise(() =>
      crypto.subtle.digest(algorithm, new Uint8Array(bytes)),
    ).pipe(Effect.map((buffer) => new Uint8Array(buffer))),
});

export const randomUUID = webCrypto.randomUUIDv4().pipe(Effect.orDie);

export const digest = (value: string) =>
  webCrypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
