import { expect, spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SetupResult } from "@arctools/twitch/server";
import * as Test from "alchemy/Test/Bun";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { makeAccountSetup } from "./account-setup.js";
import { httpEvidenceSink } from "./fixture-evidence.js";
import {
  auditedObservation,
  sanitizeTransportCause,
  FixtureRequestError,
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
      { fixture: "other" },
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
      [429, "application/json", "v1"],
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
        expect(rendered).toContain("FixtureRequestError");
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
      expect(Cause.pretty(result.cause)).toContain("transport");
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
      [snapshot, "GET", "v1", "fixture-failure"],
      [snapshot, "POST", "v1", undefined],
      [url, "GET", "v1", undefined],
      ["https://example.com/snapshot", "GET", "v1", undefined],
      [snapshot, "GET", "other", undefined],
    ] as const) {
      let calls = 0;

      const client = makeFixtureHttp(async () => {
        calls++;

        return Response.json(
          { probeError: "fixture-failure", secret: "SECRET" },
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
        result.failure instanceof FixtureRequestError
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

for (const method of ["GET", "POST"] as const) {
  test(
    `ordinary ${method} does not replay allowlisted transient loss`,
    Effect.gen(function* () {
      let calls = 0;

      const client = makeFixtureHttp(async () => {
        calls++;
        throw Object.assign(new TypeError("CANARY"), {
          cause: { code: "ECONNRESET", name: "SystemError", message: "CANARY" },
        });
      });

      const result = yield* client.request(url, { method }).pipe(Effect.exit);
      expect(calls).toBe(1);

      if (!Exit.isFailure(result))
        return yield* Effect.die("Expected transport loss");
      expect(Cause.pretty(result.cause)).toContain("ECONNRESET");
      expect(Cause.pretty(result.cause)).not.toContain("CANARY");
    }),
  );
}

test(
  "audited observation retries only transient evidence, shares one polling budget and caps each read at three wires",
  Effect.gen(function* () {
    for (const code of [
      "ECONNRESET",
      "EAI_AGAIN",
      "ENOTFOUND",
      "unknown",
    ] as const) {
      let calls = 0;
      const events: string[] = [];

      const client = makeFixtureHttp(
        async () => {
          calls++;

          if (calls < 3) throw Object.assign(new TypeError("CANARY"), { code });

          return Response.json({ value: 42 });
        },
        (event) =>
          Effect.sync(() => {
            events.push(JSON.stringify(event));
          }),
      );

      const fiber = yield* client
        .observe(
          auditedObservation(
            "provider",
            "https://provider.invalid/snapshot",
            Schema.Struct({ value: Schema.Number }),
          ),
          { until: () => true, budgetMs: 1000 },
        )
        .pipe(Effect.exit, Effect.forkScoped);

      yield* TestClock.adjust(1000);
      const result = yield* Fiber.join(fiber);
      const transient = code === "ECONNRESET" || code === "EAI_AGAIN";
      expect(Exit.isSuccess(result)).toBe(transient);
      expect(calls).toBe(transient ? 3 : 1);
      expect(events.join("\n")).not.toContain("CANARY");
    }
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

test(
  "observation counts transport and body failures toward the same three attempt cap",
  Effect.gen(function* () {
    let calls = 0;

    const client = makeFixtureHttp(async () => {
      calls++;

      if (calls === 1)
        throw Object.assign(new Error("CANARY"), { code: "ECONNRESET" });

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new Error("CANARY"), { code: "UND_ERR_SOCKET" }),
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const fiber = yield* client
      .observe(
        auditedObservation(
          "provider",
          "https://provider.invalid/snapshot",
          Schema.Unknown,
        ),
        { until: () => true, budgetMs: 2000 },
      )
      .pipe(Effect.exit, Effect.forkScoped);

    yield* TestClock.adjust(2000);
    expect(Exit.isFailure(yield* Fiber.join(fiber))).toBeTrue();
    expect(calls).toBe(3);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

test(
  "poll success does not restart observation time and an interrupted wire is aborted",
  Effect.gen(function* () {
    let calls = 0;

    const client = makeFixtureHttp(async () => {
      calls++;

      return Response.json({ value: false });
    });

    const fiber = yield* client
      .observe(
        auditedObservation(
          "provider",
          "https://provider.invalid/snapshot",
          Schema.Struct({ value: Schema.Boolean }),
        ),
        { until: (value) => value.value, budgetMs: 250 },
      )
      .pipe(Effect.exit, Effect.forkScoped);

    yield* TestClock.adjust(1000);
    const result = yield* Fiber.join(fiber);
    expect(calls).toBe(3);

    if (!Exit.isFailure(result))
      return yield* Effect.die("Expected one exhausted budget");
    expect(Cause.pretty(result.cause)).toContain("budget");
    let aborted = false;
    const entered = yield* Deferred.make<void>();

    const hanging = makeFixtureHttp(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          Effect.runSync(Deferred.succeed(entered, undefined));
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new TypeError("CANARY"));
          });
        }),
    );

    const request = yield* hanging
      .get(url, Schema.Unknown)
      .pipe(Effect.forkScoped);

    yield* Deferred.await(entered);
    yield* Fiber.interrupt(request);
    expect(aborted).toBeTrue();
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

test(
  "sanitized errors and actual evidence sinks omit canaries in every untrusted location",
  Effect.gen(function* () {
    const events: string[] = [];
    const canary = "CANARY-SECRET";

    const nested = {
      name: canary,
      code: canary,
      message: canary,
      stack: canary,
      cause: {
        name: "SystemError",
        code: "ECONNRESET",
        cause: {
          name: "TypeError",
          code: "ETIMEDOUT",
          cause: { name: canary },
        },
      },
    };

    Object.defineProperty(nested.cause.cause.cause, "message", {
      get() {
        throw new Error(canary);
      },
    });

    const client = makeFixtureHttp(
      async () => {
        throw nested;
      },
      (event) =>
        Effect.sync(() => {
          events.push(JSON.stringify(event));
        }),
    );

    const exit = yield* client
      .post(
        `https://${canary}:${canary}@example.com/${canary}?token=${canary}`,
        { token: canary },
      )
      .pipe(Effect.exit);

    if (!Exit.isFailure(exit))
      return yield* Effect.die("Expected sanitized failure");

    const rendered = [
      Cause.pretty(exit.cause),
      JSON.stringify(exit),
      ...events,
    ].join("\n");

    expect(rendered).not.toContain(canary);
    expect(rendered).toContain("ECONNRESET");
    expect(rendered).toContain("ETIMEDOUT");
    expect(sanitizeTransportCause(nested)).toHaveLength(3);
    const cycle = { name: "Error" };
    Object.defineProperty(cycle, "cause", { value: cycle });
    expect(sanitizeTransportCause(cycle)).toHaveLength(1);

    const throwing = Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error(canary);
          },
        },
        cause: {
          get() {
            throw new Error(canary);
          },
        },
      },
    );

    expect(sanitizeTransportCause(throwing)).toEqual([
      { name: "unknown", code: "unknown" },
    ]);

    for (const status of [200, 500]) {
      const responseClient = makeFixtureHttp(
        async () =>
          Response.json(
            { value: canary, probeError: canary },
            {
              status,
              headers: {
                server: canary,
                "cf-ray": canary,
                [fixtureHeader]: canary,
                "x-arc-tenant-code": canary,
              },
            },
          ),
        (event) =>
          Effect.sync(() => {
            events.push(JSON.stringify(event));
          }),
      );

      const responseExit = yield* responseClient
        .get(url, Schema.Struct({ value: Schema.Number }))
        .pipe(Effect.exit);

      if (!Exit.isFailure(responseExit))
        return yield* Effect.die("Expected response failure");
      expect(
        Cause.pretty(responseExit.cause) +
          JSON.stringify(responseExit) +
          events.join("\n"),
      ).not.toContain(canary);
    }
  }),
);

test(
  "account status snapshot cannot be opted into the observation retry protocol",
  Effect.sync(() => {
    expect(() =>
      auditedObservation(
        "provider",
        "https://arc-tools-account-test.invalid/journeys/test/snapshot",
        Schema.Unknown,
      ),
    ).toThrow("Unaudited");
    expect(() =>
      auditedObservation(
        "provider",
        "https://arc-tools-account-test-account-a0e65c16-56ec6e796e36.provider.workers.dev/journeys/test/snapshot",
        Schema.Unknown,
      ),
    ).toThrow("Unaudited");
    expect(() =>
      auditedObservation(
        "source",
        "https://example.com/observations",
        Schema.Unknown,
      ),
    ).toThrow("Unaudited");
  }),
);

test(
  "actual console and file evidence stays secret-safe and evidence failure retains the original cause",
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "arc-fixture-evidence-")),
    );

    const lines: string[] = [];

    const consoleSpy = spyOn(console, "info").mockImplementation((value) => {
      lines.push(String(value));
    });

    yield* Effect.gen(function* () {
      const sink = httpEvidenceSink(new URL(`file://${directory}/`));

      const client = makeFixtureHttp(async () => {
        throw Object.assign(new TypeError("CANARY-SECRET"), {
          code: "ECONNRESET",
        });
      }, sink);

      const exit = yield* client
        .post(
          "https://CANARY-SECRET:CANARY-SECRET@example.com/CANARY-SECRET?token=CANARY-SECRET",
        )
        .pipe(Effect.exit);

      if (!Exit.isFailure(exit))
        return yield* Effect.die("Expected safe transport error");
      yield* client.recordCleanup(
        "https://provider.invalid",
        "11111111-1111-4111-8111-111111111111",
        "confirmed",
        true,
      );

      const journal = yield* Effect.promise(() =>
        readFile(join(directory, "fixture-http-requests.jsonl"), "utf8"),
      );

      const cleanup = yield* Effect.promise(() =>
        readFile(join(directory, "journeys/fixture-controls.jsonl"), "utf8"),
      );

      expect(
        Cause.pretty(exit.cause) +
          JSON.stringify(exit) +
          journal +
          cleanup +
          lines.join("\n"),
      ).not.toContain("CANARY-SECRET");
      expect(journal).toContain("ECONNRESET");
      expect(cleanup).toContain('"state":"confirmed"');

      const failedSink = makeFixtureHttp(
        async () => {
          throw Object.assign(new TypeError("CANARY-SECRET"), {
            code: "ECONNRESET",
          });
        },
        () => Effect.die("evidence-write-failed"),
      );

      const combined = yield* failedSink.post(url).pipe(Effect.exit);

      if (!Exit.isFailure(combined))
        return yield* Effect.die("Expected combined evidence failure");
      expect(Cause.pretty(combined.cause)).toContain("evidence-write-failed");
      expect(Cause.pretty(combined.cause)).toContain("ECONNRESET");
      expect(Cause.pretty(combined.cause)).not.toContain("CANARY-SECRET");
    }).pipe(
      Effect.onExit(() =>
        Effect.promise(async () => {
          consoleSpy.mockRestore();
          await rm(directory, { recursive: true, force: true });
        }),
      ),
    );
  }),
);

test(
  "uncertain POST response loss and audited HTTP or decode failures are terminal",
  Effect.gen(function* () {
    let mutations = 0;

    const mutating = makeFixtureHttp(async () => {
      mutations++;

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new TypeError("CANARY"), { code: "ECONNRESET" }),
            );
          },
        }),
      );
    });

    expect(
      Exit.isFailure(yield* mutating.post(url).pipe(Effect.exit)),
    ).toBeTrue();
    expect(mutations).toBe(1);

    for (const [status, body, contentType] of [
      [500, "{}", "application/json"],
      [503, "{}", "application/json"],
      [429, "{}", "application/json"],
      [404, "{}", "application/json"],
      [200, "bad-json", "application/json"],
      [200, '{"value":"wrong"}', "application/json"],
      [200, '{"value":1}', "text/html"],
    ] as const) {
      let calls = 0;

      const client = makeFixtureHttp(async () => {
        calls++;

        return new Response(body, {
          status,
          headers: { "content-type": contentType },
        });
      });

      const observed = yield* client
        .observe(
          auditedObservation(
            "provider",
            "https://provider.invalid/snapshot",
            Schema.Struct({ value: Schema.Number }),
          ),
          { until: () => true, budgetMs: 1000 },
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(observed)).toBeTrue();
      expect(calls).toBe(1);
    }
  }),
);

test(
  "sanitized fallback evidence preserves known values and rejects unknown presence",
  Effect.gen(function* () {
    for (const [fallback, code] of [
      ["worker", "rpc-timeout"],
      ["worker", "ingress-budget"],
      ["worker", "rpc-defect"],
      ["worker", "rpc-failure"],
      ["CANARY", "CANARY"],
    ] as const) {
      const client = makeFixtureHttp(
        async () =>
          Response.json(
            {},
            {
              headers: {
                "x-arc-command-fallback": fallback,
                "x-arc-command-code": code,
              },
            },
          ),
        () => Effect.void,
      );

      const response = yield* client.request(
        "https://provider.invalid/snapshot",
      );

      const metadata = client.responseMetadata(response);

      expect(metadata?.tenant.fallback).toBe(
        fallback === "CANARY" ? "unknown" : fallback,
      );
      expect(metadata?.tenant.fallbackCode).toBe(
        code === "CANARY" ? "unknown" : code,
      );
      expect(JSON.stringify(metadata)).not.toContain("CANARY");
    }
  }),
);

test(
  "account setup waits only for explicit busy rejection before admission",
  Effect.gen(function* () {
    const value: SetupResult = {
      status: {
        stage: "test",
        revision: "test",
        setup: "ready",
        credential: "valid",
        sender: null,
        channels: [],
        attempts: 0,
        credentialCheckAt: null,
      },
      authorizations: [],
    };

    let calls = 0;

    const http = makeFixtureHttp(
      async () =>
        Response.json(
          ++calls === 1
            ? { kind: "failure", code: "busy" }
            : { kind: "success", value },
        ),
      () => Effect.void,
    );

    expect(
      yield* makeAccountSetup(http)("https://account.invalid/setup"),
    ).toEqual(value);
    expect(calls).toBe(2);

    for (const failure of [
      "transport",
      "provider",
      "schema",
      "status",
      "busy",
    ] as const) {
      let attempts = 0;

      const client = makeFixtureHttp(
        async () => {
          attempts++;

          if (failure === "transport")
            throw Object.assign(new TypeError(""), { code: "ECONNRESET" });

          return Response.json(
            failure === "schema" ? {} : { kind: "failure", code: failure },
            {
              status: failure === "status" ? 503 : 200,
            },
          );
        },
        () => Effect.void,
      );

      const exit = yield* makeAccountSetup(
        client,
        25,
      )("https://account.invalid/setup").pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBeTrue();

      if (failure === "busy") expect(attempts).toBeLessThanOrEqual(20);
      else expect(attempts).toBe(1);
    }
  }),
);
