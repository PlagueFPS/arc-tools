/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { expect } from "bun:test";

import {
  canonicalManifest,
  commandManifest,
  manifestHash,
  normalizeManifest,
  RemoteCommands,
  RetryAfter,
  syncCommands,
  waitForRelease,
} from "@arctools/discord/server";
import { digest, providerTransport } from "@arctools/utils/http";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Redacted,
  Result,
  Schema,
  Stream,
  Array as EffectArray,
  Option as EffectOption,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";

const { test } = Test.make({ providers: providerTransport });

const fixture = Effect.fnUntraced(function* () {
  const hash = yield* manifestHash;

  const control = {
    remote: yield* Schema.decodeEffect(RemoteCommands)(commandManifest),
    status: "ready",
    revision: "commit-one",
    hash,
    writes: 0,
    reads: 0,
    rateLimits: 0,
    rateLimitBody: yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )({ retry_after: 0.001 }).pipe(Effect.orDie),
    commandAttempts: 0,
    healthReads: 0,
    badReadback: false,
    changeAfterWrite: false,
    localizedReadback: false,
    fullReads: 0,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/health") {
        control.healthReads++;

        return Response.json({
          status: control.status,
          stage: "staging",
          revision: control.revision,
          manifestHash: control.hash,
        });
      }

      if (path !== "/applications/fixture-discord/commands")
        return new Response(null, { status: 404 });
      control.commandAttempts++;

      if (control.rateLimits > 0) {
        control.rateLimits--;

        return new Response(control.rateLimitBody, { status: 429 });
      }

      if (request.method === "PUT") {
        control.writes++;
        const raw = await request.json();
        control.remote = Schema.decodeUnknownSync(RemoteCommands)(raw);

        if (control.localizedReadback)
          control.remote = EffectArray.map(control.remote, (command) => ({
            ...command,
            name_localizations: { de: "falsch" },
          }));

        if (control.changeAfterWrite) control.revision = "commit-newer";

        return Response.json(control.remote);
      }

      control.reads++;
      const full = url.searchParams.get("with_localizations") === "true";

      if (full) control.fullReads++;

      return Response.json(
        control.badReadback
          ? []
          : EffectArray.map(control.remote, (command) => {
              const result = {
                ...command,
                id: "server-id",
                application_id: "fixture-discord",
                version: "server-version",
              };

              if (!full) {
                result.name_localizations = undefined;
                result.description_localizations = undefined;
                result.options = EffectOption.getOrUndefined(
                  EffectOption.map(
                    EffectOption.fromNullishOr(command.options),
                    (effectNativeValue0) =>
                      EffectArray.map(effectNativeValue0, (option) => ({
                        ...option,
                        name_localizations: undefined,
                        description_localizations: undefined,
                        choices: EffectOption.getOrUndefined(
                          EffectOption.map(
                            EffectOption.fromNullishOr(option.choices),
                            (effectNativeValue1) =>
                              EffectArray.map(effectNativeValue1, (choice) => ({
                                ...choice,
                                name_localizations: undefined,
                              })),
                          ),
                        ),
                      })),
                  ),
                );
              }

              return result;
            }),
      );
    },
  });

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));
  const endpoint = `http://127.0.0.1:${server.port}`;

  return {
    control,
    release: {
      stage: "staging",
      revision: "commit-one",
      endpoint,
      applicationId: "fixture-discord",
      token: Redacted.make("canary-discord-token"),
    },
    options: { api: endpoint },
  };
});

test(
  "full localization reads detect and remove drift on commands, options and choices",
  Effect.gen(function* () {
    const f = yield* fixture();

    const desired = yield* Schema.decodeEffect(RemoteCommands)([
      {
        ...commandManifest[0],
        name: "buy",
        options: [
          {
            type: 3,
            name: "item",
            description: "Item name",
            choices: [{ name: "Sensor", value: "sensor" }],
          },
        ],
      },
    ]);

    f.control.hash = yield* digest(canonicalManifest(desired));
    const options = { ...f.options, desired };

    for (const location of [
      "name",
      "description",
      "option-name",
      "option-description",
      "choice",
    ]) {
      f.control.remote = EffectArray.map(desired, (command) => {
        const result = {
          ...command,
          options: EffectOption.getOrUndefined(
            EffectOption.map(
              EffectOption.fromNullishOr(command.options),
              (effectNativeValue2) =>
                EffectArray.map(effectNativeValue2, (option) => {
                  const localized = {
                    ...option,
                    choices: EffectOption.getOrUndefined(
                      EffectOption.map(
                        EffectOption.fromNullishOr(option.choices),
                        (effectNativeValue3) =>
                          EffectArray.map(effectNativeValue3, (choice) => {
                            const localizedChoice = { ...choice };

                            if (location === "choice")
                              localizedChoice.name_localizations = {
                                de: "Sensoren",
                              };

                            return localizedChoice;
                          }),
                      ),
                    ),
                  };

                  if (location === "option-name")
                    localized.name_localizations = { de: "objekt" };

                  if (location === "option-description")
                    localized.description_localizations = { de: "Objekt" };

                  return localized;
                }),
            ),
          ),
        };

        if (location === "name") result.name_localizations = { de: "kaufen" };

        if (location === "description")
          result.description_localizations = { de: "Kaufen" };

        return result;
      });
      expect(
        (yield* syncCommands(f.release, { ...options, checkOnly: true })).drift,
      ).toBeTrue();
      expect((yield* syncCommands(f.release, options)).changed).toBeTrue();
      expect((yield* syncCommands(f.release, options)).changed).toBeFalse();
    }

    expect(f.control.writes).toBe(5);
    expect(f.control.fullReads).toBe(f.control.reads);
    f.control.remote = [];
    f.control.localizedReadback = true;
    expect(
      (yield* syncCommands(f.release, options).pipe(Effect.flip)).code,
    ).toBe("readback");
  }),
);

test(
  "manifest owns all ten guild-only slash definitions and string options",
  Effect.sync(() => {
    expect(commandManifest.length).toBe(10);
    expect(EffectArray.map(commandManifest, (command) => command.name)).toEqual(
      [
        "buy",
        "loot",
        "craft",
        "find",
        "sell",
        "recycle",
        "recycleto",
        "event",
        "upcoming",
        "active",
      ],
    );
    expect(
      EffectArray.every(
        commandManifest,
        (command) =>
          !!(
            EffectArray.join(EffectArray.map(command.contexts, String), ",") ===
              "0" &&
            EffectArray.join(
              EffectArray.map(command.integration_types, String),
              ",",
            ) === "0"
          ),
      ),
    ).toBeTrue();
    expect(commandManifest[0]?.options).toEqual([
      {
        type: 3,
        name: "item",
        description: "Item name",
        required: true,
        autocomplete: false,
        choices: [],
        name_localizations: null,
        description_localizations: null,
      },
    ]);
    expect(commandManifest[8]?.options).toEqual([]);
    expect(
      normalizeManifest([
        { name: "active", description: "text", contexts: [0] },
      ]),
    ).toEqual(
      normalizeManifest([
        {
          type: 1,
          name: "active",
          description: "text",
          contexts: [0],
          integration_types: [0],
          options: [],
          default_member_permissions: null,
          nsfw: false,
          name_localizations: {},
          description_localizations: null,
        },
      ]),
    );
  }),
);

test(
  "remote defaults and server fields are a no-op, while add, update and delete converge",
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* syncCommands(f.release, f.options)).toEqual({
      changed: false,
      drift: false,
      hash: f.control.hash,
    });
    expect(f.control.writes).toBe(0);
    f.control.remote = [
      ...commandManifest.slice(1),
      {
        ...commandManifest[0],
        type: 1,
        name: "obsolete",
        description: "obsolete",
        options: [],
        contexts: [0],
        integration_types: [0],
        default_member_permissions: null,
        nsfw: false,
        name_localizations: null,
        description_localizations: null,
      },
    ];
    f.control.remote = EffectArray.map(f.control.remote, (command, index) =>
      index === 0 ? { ...command, description: "changed remotely" } : command,
    );
    expect((yield* syncCommands(f.release, f.options)).changed).toBeTrue();
    expect(f.control.remote).toEqual(commandManifest);
    expect(f.control.writes).toBe(1);
    yield* syncCommands(f.release, f.options);
    expect(f.control.writes).toBe(1);
  }),
);

test(
  "429 retries are bounded and honor the provider before global overwrite",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.rateLimits = 2;
    f.control.remote = [];
    expect((yield* syncCommands(f.release, f.options)).changed).toBeTrue();
    expect(f.control.rateLimits).toBe(0);
    expect(f.control.writes).toBe(1);
    f.control.rateLimits = 4;
    const error = yield* syncCommands(f.release, f.options).pipe(Effect.flip);
    expect(error.code).toBe("rate-limit");
    expect(f.control.writes).toBe(1);
  }),
);

test(
  "retry delays round positive fractional seconds up to whole milliseconds and reject invalid numbers",
  Effect.gen(function* () {
    const delays: ReadonlyArray<readonly [number, number]> = [
      [0.0011, 2],
      [0.000_000_1, 1],
      [Number.MIN_VALUE, 1],
      [1.25, 1250],
    ];

    for (const [seconds, milliseconds] of delays) {
      const delay = yield* Schema.decodeEffect(RetryAfter)(seconds);
      expect(Duration.toMillis(delay)).toBe(milliseconds);
    }

    for (const value of [
      0,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.MAX_VALUE,
    ])
      expect(
        Result.isFailure(
          yield* Schema.decodeEffect(RetryAfter)(value).pipe(Effect.result),
        ),
      ).toBeTrue();
  }),
);

const invalidRetryBodies: ReadonlyArray<readonly [string, "rate-limit"]> = [
  ['{"retry_after":0}', "rate-limit"],
  ['{"retry_after":-0.1}', "rate-limit"],
  ['{"retry_after":1e999}', "rate-limit"],
  ['{"retry_after":1e308}', "rate-limit"],
  ['{"retry_after":30}', "rate-limit"],
  ['{"retry_after":"0.001"}', "rate-limit"],
  ['{"retry_after":null}', "rate-limit"],
  ["{}", "rate-limit"],
];

for (const [body, code] of invalidRetryBodies)
  test(
    `429 delay ${body} stays ${code} and never retries or overwrites`,
    Effect.gen(function* () {
      const f = yield* fixture();
      f.control.remote = [];
      f.control.rateLimits = 4;
      f.control.rateLimitBody = body;
      const error = yield* syncCommands(f.release, f.options).pipe(Effect.flip);
      expect(error.code).toBe(code);
      expect(error.phase).toBe("before");
      expect(f.control.commandAttempts).toBe(1);
      expect(f.control.healthReads).toBe(1);
      expect(f.control.writes).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "a fractional retry rechecks health before the next attempt and after completion",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.rateLimits = 1;
    f.control.rateLimitBody = '{"retry_after":0.0000001}';
    expect((yield* syncCommands(f.release, f.options)).changed).toBeFalse();
    expect(f.control.commandAttempts).toBe(2);
    expect(f.control.healthReads).toBe(3);
    expect(f.control.writes).toBe(0);
  }),
);

test(
  "readback disagreement fails after overwrite and reports partial synchronization",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.remote = [];
    f.control.badReadback = true;
    const error = yield* syncCommands(f.release, f.options).pipe(Effect.flip);
    expect(error.code).toBe("readback");
    expect(error.phase).toBe("after");
    expect(f.control.writes).toBe(1);
  }),
);

test(
  "stale release never overwrites and a deployment race after PUT fails its final fence",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.revision = "commit-newer";
    expect(
      (yield* syncCommands(f.release, f.options).pipe(Effect.flip)).code,
    ).toBe("stale-release");
    expect(f.control.writes).toBe(0);
    f.control.revision = "commit-one";
    f.control.remote = [];
    f.control.changeAfterWrite = true;
    const error = yield* syncCommands(f.release, f.options).pipe(Effect.flip);
    expect(error.code).toBe("stale-release");
    expect(error.phase).toBe("after");
    expect(f.control.writes).toBe(1);
  }),
);

test(
  "an incomplete application cannot synchronize even when its revision and manifest match",
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.status = "starting";
    f.control.remote = [];
    const error = yield* syncCommands(f.release, f.options).pipe(Effect.flip);
    expect(error.code).toBe("body");
    expect(error.phase).toBe("before");
    expect(f.control.reads).toBe(0);
    expect(f.control.writes).toBe(0);
    f.control.status = "ready";
    expect((yield* syncCommands(f.release, f.options)).changed).toBeTrue();
    expect(f.control.writes).toBe(1);
  }),
);

const nativeResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: string,
  status = 200,
) => {
  const native = HttpClientResponse.fromWeb(
    request,
    new Response(body, { status }),
  );

  Object.defineProperty(native, "stream", {
    value: Stream.make(new TextEncoder().encode(body)),
  });

  return native;
};

const nativeFixture = Effect.fnUntraced(function* () {
  const hash = yield* manifestHash;
  const entered = yield* Deferred.make<void>();

  const requests: {
    path: string;
    method: string;
    authorization: string | undefined;
    time: number;
  }[] = [];

  const control = {
    stage: "staging",
    revision: "commit-one",
    hash,
    healthStatus: 200,
    commandStatus: 200,
    retryAfter: 0.0011,
    rateLimits: 0,
    staleOnRateLimit: false,
    networkFailure: false,
    commandBody: yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(commandManifest).pipe(Effect.orDie),
  };

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      requests.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.authorization,
        time,
      });

      if (url.pathname === "/health") {
        yield* Deferred.succeed(entered, undefined);
        expect(request.headers.authorization).toBeUndefined();

        return nativeResponse(
          request,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            status: "ready",
            stage: control.stage,
            revision: control.revision,
            manifestHash: control.hash,
          }).pipe(Effect.orDie),
          control.healthStatus,
        );
      }

      expect(request.headers.authorization).toBe("Bot canary-discord-token");
      expect(url.searchParams.get("with_localizations")).toBe("true");

      if (control.networkFailure)
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: "canary-network",
          }),
        });

      if (control.rateLimits > 0) {
        control.rateLimits--;

        if (control.staleOnRateLimit) control.revision = "commit-newer";

        return nativeResponse(
          request,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            retry_after: control.retryAfter,
          }).pipe(Effect.orDie),
          429,
        );
      }

      return nativeResponse(
        request,
        control.commandBody,
        control.commandStatus,
      );
    }),
  );

  const release = {
    stage: "staging",
    revision: "commit-one",
    endpoint: "https://release.invalid",
    applicationId: "fixture-discord",
    token: Redacted.make("canary-discord-token"),
  };

  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, client));

  return { control, requests, release, run, started: Deferred.await(entered) };
});

test(
  "scheduled Discord retries allow four total rate-limited attempts and never sleep after the last one",
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    f.control.rateLimits = 4;

    const fiber = yield* f
      .run(syncCommands(f.release))
      .pipe(Effect.result, Effect.forkChild);

    yield* f.started;
    yield* TestClock.adjust(6);
    const result = yield* Fiber.join(fiber);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "rate-limit",
      phase: "before",
    });

    const calls = EffectArray.filter(
      f.requests,
      ({ path }) => !!(path !== "/health"),
    );

    expect(EffectArray.map(calls, ({ time }) => time)).toEqual([0, 2, 4, 6]);
    expect(
      EffectArray.filter(f.requests, ({ path }) => !!(path === "/health")),
    ).toHaveLength(4);
  }).pipe(Effect.provide(TestClock.layer())),
);

test(
  "every delayed retry fences the exact release before another command request",
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    f.control.rateLimits = 1;
    f.control.staleOnRateLimit = true;

    const fiber = yield* f
      .run(syncCommands(f.release))
      .pipe(Effect.result, Effect.forkChild);

    yield* f.started;
    yield* TestClock.adjust(2);
    const result = yield* Fiber.join(fiber);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "stale-release",
      phase: "before",
    });
    expect(
      EffectArray.map(f.requests, ({ path, time }) => [path, time]),
    ).toEqual([
      ["/health", 0],
      ["/api/v10/applications/fixture-discord/commands", 0],
      ["/health", 2],
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
);

for (const failure of ["status", "malformed", "stage", "revision", "manifest"])
  test(
    `Discord ${failure} failures stop immediately without a retry`,
    Effect.gen(function* () {
      const f = yield* nativeFixture();

      if (failure === "status") f.control.commandStatus = 401;

      if (failure === "malformed") f.control.commandBody = "{";

      if (failure === "stage") f.control.stage = "other-stage";

      if (failure === "revision") f.control.revision = "other-revision";

      if (failure === "manifest") f.control.hash = "other-manifest";
      const result = yield* f.run(syncCommands(f.release)).pipe(Effect.flip);
      expect(result.code).toBe(
        ["stage", "revision", "manifest"].includes(failure)
          ? "stale-release"
          : failure === "malformed"
            ? "body"
            : "provider",
      );
      expect(result.phase).toBe("before");
      expect(
        EffectArray.filter(f.requests, ({ path }) => !!(path === "/health")),
      ).toHaveLength(1);
      expect(
        EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
      ).toHaveLength(
        ["stage", "revision", "manifest"].includes(failure) ? 0 : 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "Discord delay admission uses the original per-call horizon and rejects equality",
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    f.control.rateLimits = 4;
    f.control.retryAfter = 15;

    const fiber = yield* f
      .run(syncCommands(f.release))
      .pipe(Effect.result, Effect.forkChild);

    yield* f.started;
    yield* TestClock.adjust(15000);
    const result = yield* Fiber.join(fiber);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "rate-limit",
      phase: "before",
    });
    expect(
      EffectArray.map(
        EffectArray.filter(f.requests, ({ path }) => !!(path !== "/health")),
        ({ time }) => time,
      ),
    ).toEqual([0, 15000]);
  }).pipe(Effect.provide(TestClock.layer())),
);

for (const wait of [false, true])
  test(
    `release polling makes ${wait ? 60 : 1} attempts with no final sleep`,
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      f.control.healthStatus = 503;

      const fiber = yield* f
        .run(waitForRelease(f.release, wait).pipe(Effect.result))
        .pipe(Effect.forkChild);

      yield* f.started;
      yield* TestClock.adjust(wait ? 59000 : 0);
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBeTrue();
      expect(EffectArray.map(f.requests, ({ time }) => time)).toEqual(
        Array.from({ length: wait ? 60 : 1 }, (_, i) => i * 1000),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

test(
  "release polling stops at the first exact healthy revision and manifest",
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    f.control.revision = "other";

    const fiber = yield* f
      .run(waitForRelease(f.release, true))
      .pipe(Effect.forkChild);

    yield* f.started;
    yield* TestClock.adjust(1000);
    expect(f.requests).toHaveLength(2);
    f.control.revision = "commit-one";
    yield* f.started;
    yield* TestClock.adjust(1000);
    expect(yield* Fiber.join(fiber)).toBeUndefined();
    expect(f.requests).toHaveLength(3);
  }).pipe(Effect.provide(TestClock.layer())),
);
