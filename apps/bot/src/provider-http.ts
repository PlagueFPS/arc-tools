import { Crypto, Effect, Schema, Stream } from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  {
    kind: Schema.Literals(["network", "body", "deadline"]),
  },
) {}
export const request = Effect.fn("Provider.request")(
  function* (url: string, init: RequestInit, _timeoutMs = 4_000) {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const outgoing = yield* Effect.try(() =>
      HttpClientRequest.fromWeb(
        new Request(url, { ...init, signal: undefined }),
      ),
    );
    const response = yield* client.execute(outgoing);
    const headers = new Headers(response.headers);
    if (
      (response.status < 200 || response.status >= 300) &&
      response.status !== 429
    )
      return { status: response.status, headers, body: null };
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* response.stream.pipe(
      Stream.catchReason(
        "HttpClientError",
        "EmptyBodyError",
        () => Stream.empty,
      ),
      Stream.runForEach(
        Effect.fnUntraced(function* (chunk) {
          size += chunk.byteLength;
          if (size > 256 * 1024)
            return yield* new ProviderError({ kind: "network" });
          chunks.push(chunk);
        }),
      ),
    );
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    let body: unknown = null;
    if (size > 0) {
      body = yield* Effect.try(() =>
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    }
    return { status: response.status, headers, body };
  },
  (effect, _url, init, timeoutMs = 4_000) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...init,
        redirect: "manual",
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.timeout(timeoutMs),
      Effect.mapError(() => new ProviderError({ kind: "network" })),
    ),
);
export const decodeBody = Effect.fnUntraced(function* <A, I>(
  schema: Schema.Codec<A, I>,
  body: unknown,
) {
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(() => new ProviderError({ kind: "body" })),
  );
});
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
