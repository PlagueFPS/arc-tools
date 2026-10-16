import { Effect, Schema } from "effect";

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  {
    kind: Schema.Literals(["network", "body", "deadline"]),
  },
) {}
export const request = Effect.fn("Provider.request")(function* (
  url: string,
  init: RequestInit,
  timeoutMs = 4_000,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const controller = new AbortController();
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, controller.signal]),
        redirect: "manual",
      });
      if (!response.ok && response.status !== 429) {
        void response.body?.cancel().catch(() => {});
        controller.abort();
        return {
          status: response.status,
          headers: response.headers,
          body: null,
        };
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 256 * 1024) throw new Error("bounded body");
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      let body: unknown = null;
      if (size > 0) {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new Error("invalid JSON");
        }
      }
      return { status: response.status, headers: response.headers, body };
    },
    catch: () => new ProviderError({ kind: "network" }),
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.mapError(() => new ProviderError({ kind: "network" })),
  );
});
export const decodeBody = Effect.fnUntraced(function* <A, I>(
  schema: Schema.Codec<A, I>,
  body: unknown,
) {
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(() => new ProviderError({ kind: "body" })),
  );
});
export const digest = (value: string) =>
  Effect.promise(async () =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
