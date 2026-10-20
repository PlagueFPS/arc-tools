import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Cause, Effect, Exit, Fiber, Layer, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  FixtureHttpError,
  fixtureHeader,
  isRouteNotReady,
  makeFixtureHttp,
  reconstructedSnapshot,
} from "./fixture-http.js";

const { test } = Test.make({ providers: Layer.empty });

const url =
  "https://arc-tools-probe-test-account-a0e65c16-56ec6e796e36.plague.workers.dev/arm";

const placeholder = {
  method: "POST",
  route: `${new URL(url).hostname}/arm`,
  status: 404,
  contentType: "text/html; charset=UTF-8",
  server: "cloudflare",
  ray: "a4b03d23bc185668-IAD",
  fixture: null,
  bodyBytes: 19984,
  bodySha256:
    "2000e6b28a1517ba1268e1649cd3163326ef839492edfdba31e8959830580976",
};

test(
  "only the observed Cloudflare placeholder on a disposable Worker is route readiness",
  Effect.sync(() => {
    expect(isRouteNotReady(new URL(url), placeholder)).toBeTrue();

    for (const change of [
      { status: 500 },
      { status: 200 },
      { contentType: "application/json" },
      { server: "other" },
      { fixture: "v1" },
      { bodySha256: "different-html" },
    ])
      expect(
        isRouteNotReady(new URL(url), { ...placeholder, ...change }),
      ).toBeFalse();

    for (const host of [
      "https://example.com/arm",
      "https://arc-tools-probe-prod.plague.workers.dev/arm",
      "https://arc-tools-probe-staging.plague.workers.dev/arm",
      "http://arc-tools-probe-test-account-a0e65c16-56ec6e796e36.plague.workers.dev/arm",
    ])
      expect(isRouteNotReady(new URL(host), placeholder)).toBeFalse();
  }),
);

test(
  "fixture and unrecognized edge failures stop POST without replaying a mutation or exposing its body",
  Effect.gen(function* () {
    for (const [status, contentType, marker] of [
      [404, "application/json", "v1"],
      [404, "text/html", null],
      [500, "text/html", null],
      [503, "application/json", "v1"],
      [302, "text/html", null],
    ] as const) {
      let calls = 0;

      const client = makeFixtureHttp(async (_url, init) => {
        calls++;
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");

        const headers = new Headers({ "content-type": contentType });

        if (marker) headers.set(fixtureHeader, marker);

        return new Response("SECRET-BUSINESS-BODY", { status, headers });
      });

      const result = yield* Effect.exit(
        client.post(`${url}?token=SECRET-QUERY`, { secret: "SECRET-REQUEST" }),
      );

      expect(Exit.isFailure(result)).toBeTrue();
      expect(calls).toBe(1);

      if (Exit.isFailure(result)) {
        const rendered = Cause.pretty(result.cause);
        expect(rendered).not.toContain("SECRET-");
        expect(rendered).toContain("FixtureHttpError");
      }
    }
  }),
);

test(
  "transport loss after a POST has unknown execution and is never replayed",
  Effect.gen(function* () {
    let calls = 0;

    const client = makeFixtureHttp(async () => {
      calls++;
      throw new Error("SECRET-TRANSPORT-BODY");
    });

    const result = yield* Effect.exit(client.post(url));
    expect(calls).toBe(1);
    expect(Exit.isFailure(result)).toBeTrue();

    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        "execution unknown, not retried",
      );
      expect(Cause.pretty(result.cause)).not.toContain("SECRET-");
    }
  }),
);

test(
  "successful HTTP with wrong content type, invalid JSON, or invalid business data is not retried",
  Effect.gen(function* () {
    for (const [body, contentType, status] of [
      ['{"value":1}', "text/html", 200],
      ["SECRET-INVALID-JSON", "application/json", 200],
      ['{"value":"wrong-type"}', "application/json", 200],
      ['{"value":1}', "application/json", 201],
    ] as const) {
      let calls = 0;

      const client = makeFixtureHttp(async () => {
        calls++;

        return new Response(body, {
          status,
          headers: { "content-type": contentType },
        });
      });

      const result = yield* Effect.exit(
        client.get(url, Schema.Struct({ value: Schema.Number })),
      );

      expect(Exit.isFailure(result)).toBeTrue();
      expect(calls).toBe(1);

      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).not.toContain("SECRET-");
    }
  }),
);

test(
  "raw binary and schema-decoded JSON responses retain their actual values",
  Effect.gen(function* () {
    const bytes = new Uint8Array([0, 255, 13, 10]);

    const client = makeFixtureHttp(async (_url, init) =>
      init.method === "POST"
        ? new Response(bytes, {
            headers: { "content-type": "application/octet-stream" },
          })
        : Response.json({ value: 42 }),
    );

    const response = yield* client.request(url, {
      method: "POST",
      body: bytes,
    });

    expect(
      new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
    ).toEqual(bytes);
    expect(
      yield* client.get(url, Schema.Struct({ value: Schema.Number })),
    ).toEqual({ value: 42 });
  }),
);

test(
  "reconstruction polls the observed UUID and preserves the new snapshot",
  Effect.gen(function* () {
    let calls = 0;

    const read = Effect.sync(() => ({
      instance: ++calls < 3 ? "original" : "reconstructed",
      value: "committed",
      alarm: 123,
    }));

    const fiber = yield* reconstructedSnapshot(read, "original").pipe(
      Effect.forkChild,
    );

    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toEqual({
      instance: "reconstructed",
      value: "committed",
      alarm: 123,
    });
    expect(calls).toBe(3);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "an unchanged UUID exhausts a bounded poll and a snapshot failure stops immediately",
  Effect.gen(function* () {
    let calls = 0;

    const read = Effect.sync(() => {
      calls++;

      return { instance: "original" };
    });

    const fiber = yield* reconstructedSnapshot(read, "original").pipe(
      Effect.exit,
      Effect.forkChild,
    );

    yield* TestClock.adjust("3 seconds");
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBeTrue();
    expect(calls).toBe(21);

    if (Exit.isFailure(result))
      expect(Cause.pretty(result.cause)).toContain(
        "Reconstruction not observed",
      );
    let failures = 0;

    const failed = yield* Effect.exit(
      reconstructedSnapshot(
        Effect.suspend(() => {
          failures++;

          return Effect.fail("snapshot defect");
        }),
        "original",
      ),
    );

    expect(Exit.isFailure(failed)).toBeTrue();
    expect(failures).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "probe snapshot failures retain their explanation without retrying or exposing other response bodies",
  Effect.gen(function* () {
    const snapshot = url.replace("/arm", "/snapshot");

    for (const [target, method, marker, expected] of [
      [snapshot, "GET", "v1", "RPC initialization failed"],
      [snapshot, "POST", "v1", undefined],
      [url, "GET", "v1", undefined],
      ["https://example.com/snapshot", "GET", "v1", undefined],
      [snapshot, "GET", "other", undefined],
    ] as const) {
      let calls = 0;

      const client = makeFixtureHttp(async () => {
        calls++;

        return Response.json(
          { probeError: "RPC initialization failed", secret: "SECRET" },
          {
            status: 500,
            headers: { [fixtureHeader]: marker },
          },
        );
      });

      const result = yield* Effect.result(client.request(target, { method }));
      expect(calls).toBe(1);
      expect(result._tag).toBe("Failure");

      if (
        Predicate.isTagged(result, "Failure") &&
        result.failure instanceof FixtureHttpError
      ) {
        expect(result.failure.diagnostic).toMatchObject({ status: 500 });
        expect(
          "probeError" in result.failure.diagnostic
            ? result.failure.diagnostic.probeError
            : undefined,
        ).toBe(expected);
        expect(JSON.stringify(result.failure.diagnostic)).not.toContain(
          "SECRET",
        );
      } else throw new Error("Expected a fixture HTTP failure");
    }
  }),
);
