/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { expect } from "bun:test";

import {
  commandManifest,
  manifestHash,
  preflightCommands,
  syncCommands,
  syncDiagnostic,
  waitForRelease,
  type RemoteCommands,
} from "@arctools/discord/server";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Logger,
  Match,
  Result,
  Layer,
  Redacted,
  Stream,
  Array as EffectArray,
  Schema as EffectSchema,
} from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

const { test } = Test.make({ providers: Layer.empty });

type Reply =
  | { readonly kind: "http"; readonly status: number; readonly body: string }
  | { readonly kind: "stalled-body"; readonly status: number }
  | { readonly kind: "stream-failure" }
  | { readonly kind: "network" }
  | { readonly kind: "lost-write" }
  | { readonly kind: "stall" };

type Replies = Record<"health" | "read" | "overwrite", Reply[]>;

interface Control {
  remote: RemoteCommands;
  revision: string;
  writes: number;
  staleAfterWrite: boolean;
  latency: number;
}

const fixture = Effect.fnUntraced(function* () {
  const hash = yield* manifestHash;
  const started = yield* Deferred.make<void>();
  const requests: { method: string; path: string; time: number }[] = [];
  const logs: string[] = [];

  const replies: Replies = {
    health: [],
    read: [],
    overwrite: [],
  };

  const control: Control = {
    remote: commandManifest,
    revision: "commit-one",
    writes: 0,
    staleAfterWrite: false,
    latency: 0,
  };

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push({
        method: request.method,
        path: url.pathname,
        time: yield* Clock.currentTimeMillis,
      });
      yield* Deferred.succeed(started, undefined);
      yield* Effect.sleep(control.latency);
      const health = url.pathname === "/health";
      expect(request.headers.authorization).toBe(
        health ? undefined : "Bot canary-token",
      );

      const reply = (
        health
          ? replies.health
          : request.method === "PUT"
            ? replies.overwrite
            : replies.read
      ).shift();

      if (request.method === "PUT") {
        control.writes++;

        if (!reply || reply.kind === "lost-write")
          control.remote = commandManifest;

        if (control.staleAfterWrite) control.revision = "commit-newer";
      }

      if (reply?.kind === "stall") return yield* Effect.never;

      if (reply?.kind === "network" || reply?.kind === "lost-write")
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: "canary-network",
          }),
        });

      const body =
        reply?.kind === "http"
          ? reply.body
          : yield* EffectSchema.encodeEffect(
              EffectSchema.fromJsonString(EffectSchema.Unknown),
            )(
              health
                ? {
                    status: "ready",
                    stage: "staging",
                    revision: control.revision,
                    manifestHash: hash,
                  }
                : control.remote,
            ).pipe(Effect.orDie);

      const response = HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status:
            reply?.kind === "http" || reply?.kind === "stalled-body"
              ? reply.status
              : 200,
        }),
      );

      Object.defineProperty(response, "stream", {
        value: Match.value(reply?.kind).pipe(
          Match.when("stalled-body", () => Stream.never),
          Match.when("stream-failure", () =>
            Stream.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: "canary-stream",
                }),
              }),
            ),
          ),
          Match.orElse(() => Stream.make(new TextEncoder().encode(body))),
        ),
      });

      return response;
    }),
  );

  const release = {
    stage: "staging",
    revision: "commit-one",
    endpoint: "https://release.invalid",
    applicationId: "fixture",
    token: Redacted.make("canary-token"),
  };

  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            logs.push(JSON.stringify(message));
          }),
        ]),
      ),
    );

  const finish = Effect.fnUntraced(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    elapsed = 25_000,
  ) {
    const fiber = yield* run(effect).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(elapsed);

    return yield* Fiber.join(fiber);
  });

  return { control, replies, requests, logs, release, finish };
});

for (const operation of ["health", "read"] as const)
  for (const reply of [
    { kind: "http", status: 503, body: '{"message":"canary-body"}' },
    { kind: "network" },
  ] satisfies Reply[])
    test(
      `${operation} ${reply.kind} failure recovers before command mutation`,
      Effect.gen(function* () {
        const f = yield* fixture();
        f.control.remote = [];
        f.replies[operation].push(reply);
        expect((yield* f.finish(syncCommands(f.release))).changed).toBeTrue();
        expect(f.control.writes).toBe(1);
        expect(f.logs).toHaveLength(1);
        expect(
          EffectArray.join(EffectArray.map(f.logs, String), ","),
        ).not.toContain("canary");
      }).pipe(Effect.provide(TestClock.layer())),
    );

for (const reply of [
  { kind: "http", status: 503, body: '{"code":123,"message":"canary-body"}' },
  { kind: "network" },
] satisfies Reply[])
  test(
    `persistent ${reply.kind} failures exhaust four attempts with bounded backoff`,
    Effect.gen(function* () {
      const f = yield* fixture();
      f.replies.read.push(reply, reply, reply, reply);
      const error = yield* f.finish(syncCommands(f.release).pipe(Effect.flip));
      expect(syncDiagnostic(error)).toMatchObject({
        operation: "read",
        phase: "before",
        attempt: 4,
        retryCount: 3,
        code: reply.kind === "http" ? "provider" : "network",
      });
      expect(
        EffectArray.map(
          EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
          ({ time }) => time,
        ),
      ).toEqual([0, 250, 750, 1750]);
      expect(f.control.writes).toBe(0);
      expect(f.logs).toHaveLength(3);
      expect(
        yield* EffectSchema.encodeEffect(
          EffectSchema.fromJsonString(EffectSchema.Unknown),
        )({ logs: f.logs, diagnostic: syncDiagnostic(error) }).pipe(
          Effect.orDie,
        ),
      ).not.toContain("canary");
    }).pipe(Effect.provide(TestClock.layer())),
  );

for (const status of [400, 401, 403])
  test(
    `preflight HTTP ${status} fails permanently with numeric provider diagnostics and no writes`,
    Effect.gen(function* () {
      const f = yield* fixture();
      f.replies.read.push({
        kind: "http",
        status,
        body: '{"code":50001,"message":"canary-body","token":"canary-token"}',
      });

      const error = yield* f.finish(
        preflightCommands(f.release).pipe(Effect.flip),
      );

      expect(syncDiagnostic(error)).toEqual({
        event: "discord-sync-failure",
        code: "provider",
        operation: "preflight",
        phase: "before",
        attempt: 1,
        retryCount: 0,
        status,
        discordCode: 50001,
      });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.method).toBe("GET");
      expect(f.control.writes).toBe(0);
      expect(f.logs).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "successful authenticated preflight reads commands without accessing the Worker",
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.finish(preflightCommands(f.release));
    expect(
      EffectArray.map(f.requests, ({ method, path }) => [method, path]),
    ).toEqual([["GET", "/api/v10/applications/fixture/commands"]]);
    expect(f.control.writes).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "request deadlines are retried and reported separately from network errors",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.replies.read.push(
      { kind: "stall" },
      { kind: "stall" },
      { kind: "stall" },
      { kind: "stall" },
    );
    const error = yield* f.finish(syncCommands(f.release).pipe(Effect.flip));
    expect(syncDiagnostic(error)).toMatchObject({
      code: "deadline",
      operation: "read",
      attempt: 4,
      status: null,
    });
    expect(f.control.writes).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "a committed overwrite whose response is lost is read back before another PUT",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.replies.overwrite.push({ kind: "lost-write" });
    expect((yield* f.finish(syncCommands(f.release))).changed).toBeTrue();
    expect(f.control.writes).toBe(1);
    expect(
      EffectArray.map(
        EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
        ({ method }) => method,
      ),
    ).toEqual(["GET", "PUT", "GET"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "an overwrite rejected by a transient failure is repeated only after a fresh read",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.replies.overwrite.push({
      kind: "http",
      status: 503,
      body: "canary-body",
    });
    yield* f.finish(syncCommands(f.release));
    expect(
      EffectArray.map(
        EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
        ({ method }) => method,
      ),
    ).toEqual(["GET", "PUT", "GET", "PUT", "GET"]);
    expect(f.control.remote).toEqual(commandManifest);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "a new deployed revision during an uncertain overwrite prevents another provider request",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.control.staleAfterWrite = true;
    f.replies.overwrite.push({ kind: "lost-write" });
    const error = yield* f.finish(syncCommands(f.release).pipe(Effect.flip));
    expect(syncDiagnostic(error)).toMatchObject({
      code: "stale-release",
      operation: "health",
      attempt: 2,
    });
    expect(
      EffectArray.map(
        EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
        ({ method }) => method,
      ),
    ).toEqual(["GET", "PUT"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "a readback transport failure reconciles the committed manifest without a second PUT",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.replies.read.push(
      { kind: "http", status: 200, body: "[]" },
      { kind: "network" },
    );
    yield* f.finish(syncCommands(f.release));
    expect(f.control.writes).toBe(1);
    expect(EffectArray.join(EffectArray.map(f.logs, String), ",")).toContain(
      '"operation":"readback"',
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "invalid provider error codes and bodies never reach diagnostics",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.replies.read.push({
      kind: "http",
      status: 401,
      body: '{"code":"canary-code","message":"canary-body"}',
    });

    const error = yield* f.finish(
      preflightCommands(f.release).pipe(Effect.flip),
    );

    expect(syncDiagnostic(error).discordCode).toBeNull();
    expect(
      yield* EffectSchema.encodeEffect(
        EffectSchema.fromJsonString(EffectSchema.Unknown),
      )(syncDiagnostic(error)).pipe(Effect.orDie),
    ).not.toContain("canary");
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "the shared sync deadline includes successful requests and stops further I/O at thirty seconds",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.latency = 3500;
    f.control.remote = [];
    f.replies.read.push(
      { kind: "http", status: 200, body: "[]" },
      { kind: "network" },
    );

    const error = yield* f.finish(
      syncCommands(f.release).pipe(Effect.flip),
      35_000,
    );

    expect(syncDiagnostic(error)).toMatchObject({
      code: "deadline",
      operation: "health",
      phase: "after",
      attempt: 2,
    });
    expect(
      EffectArray.every(f.requests, ({ time }) => !!(time < 30_000)),
    ).toBeTrue();
    expect(f.control.writes).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "a permanent authentication status survives a stalled error body without retrying",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.replies.read.push({ kind: "stalled-body", status: 401 });

    const error = yield* f.finish(
      preflightCommands(f.release).pipe(Effect.flip),
    );

    expect(syncDiagnostic(error)).toMatchObject({
      code: "provider",
      operation: "preflight",
      status: 401,
      attempt: 1,
      retryCount: 0,
    });
    expect(f.requests).toHaveLength(1);
    expect(f.logs).toEqual([]);
  }).pipe(Effect.provide(TestClock.layer())),
);

for (const seconds of [5, 60])
  test(
    `readiness honors a ${seconds}-second rate limit within its horizon`,
    Effect.gen(function* () {
      const f = yield* fixture();
      f.replies.health.push({
        kind: "http",
        status: 429,
        body: yield* EffectSchema.encodeEffect(
          EffectSchema.fromJsonString(EffectSchema.Unknown),
        )({ retry_after: seconds }).pipe(Effect.orDie),
      });

      const result = yield* f.finish(
        waitForRelease(f.release, true).pipe(Effect.result),
      );

      expect(EffectArray.map(f.requests, ({ time }) => time)).toEqual(
        seconds === 5 ? [0, 5000] : [0],
      );
      expect(Result.isSuccess(result)).toBe(seconds === 5);

      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          code: "rate-limit",
          status: 429,
        });
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "a command response stream failure retains its status and recovers without leaking its cause",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.replies.read.push({ kind: "stream-failure" });
    yield* f.finish(syncCommands(f.release));
    expect(f.control.writes).toBe(1);
    expect(EffectArray.join(EffectArray.map(f.logs, String), ",")).toContain(
      '"code":"network"',
    );
    expect(EffectArray.join(EffectArray.map(f.logs, String), ",")).toContain(
      '"status":200',
    );
    expect(
      EffectArray.join(EffectArray.map(f.logs, String), ","),
    ).not.toContain("canary");
  }).pipe(Effect.provide(TestClock.layer())),
);
