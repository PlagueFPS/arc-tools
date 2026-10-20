import { flow, Crypto, Effect, Schema, Stream } from "effect";
import { Hex } from "effect/encoding";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientRequest,
} from "effect/http";

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  {
    kind: Schema.Literals(["network", "body", "deadline"]),
  },
) {}

export const request = Effect.fn("Provider.request")(
  function* (
    outgoing: HttpClientRequest.HttpClientRequest,
    _timeoutMs = 4_000,
  ) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.withScope,
      HttpClient.filterStatus(
        (status) => (status >= 200 && status < 300) || status === 429,
      ),
    );

    const response = yield* client.execute(outgoing);
    const { status, headers } = response;

    const bytes = yield* response.stream.pipe(
      Stream.catchReason(
        "HttpClientError",
        "EmptyBodyError",
        () => Stream.empty,
      ),
      Stream.mapError(() => new ProviderError({ kind: "network" })),
      Stream.limitBytes(256 * 1024, () =>
        Stream.fail(new ProviderError({ kind: "network" })),
      ),
      Stream.mkUint8Array,
    );

    const body =
      bytes.byteLength > 0
        ? yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(new TextDecoder().decode(bytes))
        : null;

    return { status, headers, body };
  },
  (effect, _outgoing, timeoutMs = 4_000) =>
    effect.pipe(
      Effect.catchReason("HttpClientError", "StatusCodeError", ({ response }) =>
        Effect.succeed({
          status: response.status,
          headers: response.headers,
          body: null,
        }),
      ),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.timeout(timeoutMs),
      Effect.mapError(() => new ProviderError({ kind: "network" })),
    ),
);

export const decodeBody = <A, I>(schema: Schema.Codec<A, I>) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(() => new ProviderError({ kind: "body" })),
  );

const webCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.promise(
      async () =>
        new Uint8Array(
          await crypto.subtle.digest(algorithm, new Uint8Array(bytes)),
        ),
    ),
});

export const digest = (value: string) =>
  webCrypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
