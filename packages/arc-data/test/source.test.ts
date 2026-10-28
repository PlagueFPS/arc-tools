/* oxlint-disable effecttsgo/global-timers -- Process and HTTP harness deadlines must use real host timers, independently of the test clock. */
/* oxlint-disable effecttsgo/new-promise -- Native event and callback APIs require Promise resolvers at this interoperability boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { expect, test } from "bun:test";
import { createServer } from "node:http";

import {
  Effect,
  Predicate,
  Result,
  Schema,
  SchemaGetter,
  String as Str,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { DataUnavailable } from "../src/data-service.js";
import { cachePolicy, makeSource } from "../src/source.js";

type SourceBody =
  | { readonly kind: "streaming"; readonly chunk: Uint8Array }
  | { readonly kind: "complete"; readonly chunks: ReadonlyArray<Uint8Array> }
  | { readonly kind: "delayed"; readonly delayMs: number };

const sourceServer = async (status: number, body: SourceBody) => {
  const closed = Promise.withResolvers<void>();

  const server = createServer((_request, response) => {
    response.once("close", () => {
      closed.resolve();
    });

    if (body.kind === "delayed") {
      const timer = setTimeout(() => response.end('"late"'), body.delayMs);
      response.once("close", () => clearTimeout(timer));

      return;
    }

    response.writeHead(status, { "Content-Type": "application/json" });

    if (body.kind === "complete") {
      for (const chunk of body.chunks) response.write(chunk);
      response.end();

      return;
    }

    response.write(body.chunk);
    const interval = setInterval(() => response.write(body.chunk), 10);
    response.once("close", () => clearInterval(interval));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || Predicate.isString(address))
    throw new Error("Expected a local HTTP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    closed: async () => {
      const deadline = Promise.withResolvers<boolean>();
      const timer = setTimeout(() => deadline.resolve(false), 500);

      try {
        return await Promise.race([
          closed.promise.then(() => true),
          deadline.promise,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

for (const scenario of [
  { name: "rejected status", status: 503, maxBodyBytes: 1024, timeout: 1000 },
  { name: "overflow", status: 200, maxBodyBytes: 64, timeout: 1000 },
  { name: "timeout", status: 200, maxBodyBytes: 1024 * 1024, timeout: 100 },
])
  test(`source closes the HTTP response after ${scenario.name}`, async () => {
    const server = await sourceServer(scenario.status, {
      kind: "streaming",
      chunk: new TextEncoder().encode(Str.repeat(33)("x")),
    });

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* makeSource({
            baseUrl: server.url,
            policy: {
              ...cachePolicy,
              maxBodyBytes: scenario.maxBodyBytes,
              sourceTimeoutMs: scenario.timeout,
            },
          });

          return yield* source.fetch({ resource: "traders" }, Schema.String);
        }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)),
      );

      expect(result).toMatchObject(
        Result.fail(
          new DataUnavailable({
            resource: "traders",
            reason: "source",
          }),
        ),
      );
      expect(await server.closed()).toBeTrue();
    } finally {
      await server.stop();
    }
  });

for (const scenario of [
  { name: "accepts the exact UTF-8 byte limit", limit: 9, succeeds: true },
  { name: "rejects one byte over the limit", limit: 8, succeeds: false },
])
  test(`source ${scenario.name}`, async () => {
    const bytes = new TextEncoder().encode('"雪🙂"');
    expect(bytes.byteLength).toBe(9);

    const server = await sourceServer(200, {
      kind: "complete",
      chunks: [bytes.slice(0, 2), bytes.slice(2, 6), bytes.slice(6)],
    });

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* makeSource({
            baseUrl: server.url,
            policy: { ...cachePolicy, maxBodyBytes: scenario.limit },
          });

          return yield* source.fetch({ resource: "traders" }, Schema.String);
        }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)),
      );

      expect(result).toMatchObject(
        scenario.succeeds
          ? Result.succeed("雪🙂")
          : Result.fail(
              new DataUnavailable({ resource: "traders", reason: "source" }),
            ),
      );
    } finally {
      await server.stop();
    }
  });

test("source acquisition is included in its timeout and closes the connection", async () => {
  const server = await sourceServer(200, { kind: "delayed", delayMs: 2000 });

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* makeSource({
          baseUrl: server.url,
          policy: { ...cachePolicy, sourceTimeoutMs: 100 },
        });

        return yield* source.fetch({ resource: "traders" }, Schema.String);
      }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)),
    );

    expect(result).toMatchObject(
      Result.fail(
        new DataUnavailable({ resource: "traders", reason: "source" }),
      ),
    );
    expect(await server.closed()).toBeTrue();
  } finally {
    await server.stop();
  }
});

test("source maps an invalid JSON body to DataUnavailable", async () => {
  const server = await sourceServer(200, {
    kind: "complete",
    chunks: [new TextEncoder().encode("{")],
  });

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* makeSource({ baseUrl: server.url });

        return yield* source.fetch({ resource: "traders" }, Schema.String);
      }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)),
    );

    expect(result).toMatchObject(
      Result.fail(
        new DataUnavailable({ resource: "traders", reason: "source" }),
      ),
    );
  } finally {
    await server.stop();
  }
});

test("source decoding is interrupted by the source timeout", async () => {
  const server = await sourceServer(200, {
    kind: "complete",
    chunks: [new TextEncoder().encode('"slow"')],
  });

  let interrupted = false;

  const schema = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((value) =>
        Effect.sleep(2000).pipe(
          Effect.as(value),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* makeSource({
          baseUrl: server.url,
          policy: { ...cachePolicy, sourceTimeoutMs: 100 },
        });

        return yield* source.fetch({ resource: "traders" }, schema);
      }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)),
    );

    expect(result).toMatchObject(
      Result.fail(
        new DataUnavailable({ resource: "traders", reason: "source" }),
      ),
    );
    expect(interrupted).toBeTrue();
  } finally {
    await server.stop();
  }
});
