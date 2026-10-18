import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Duration, Effect, Layer, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  canonicalManifest,
  commandManifest,
  manifestHash,
  normalizeManifest,
  RemoteCommands,
} from "../src/discord-manifest.js";
import { RetryAfter, syncCommands } from "../src/discord-sync.js";
import { digest } from "../src/provider-http.js";

const { test } = Test.make({ providers: Layer.empty });
const fixture = Effect.fnUntraced(function* () {
  const hash = yield* manifestHash;
  const control = {
    remote: Schema.decodeUnknownSync(RemoteCommands)(commandManifest),
    status: "ready",
    revision: "commit-one",
    hash,
    writes: 0,
    reads: 0,
    rateLimits: 0,
    rateLimitBody: JSON.stringify({ retry_after: 0.001 }),
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
          control.remote = control.remote.map((command) => ({
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
          : control.remote.map((command) => ({
              ...command,
              ...(!full
                ? {
                    name_localizations: undefined,
                    description_localizations: undefined,
                    options: command.options?.map((option) => ({
                      ...option,
                      name_localizations: undefined,
                      description_localizations: undefined,
                      choices: option.choices?.map((choice) => ({
                        ...choice,
                        name_localizations: undefined,
                      })),
                    })),
                  }
                : {}),
              id: "server-id",
              application_id: "fixture-discord",
              version: "server-version",
            })),
      );
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
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
    const desired = Schema.decodeUnknownSync(RemoteCommands)([
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
      f.control.remote = desired.map((command) => ({
        ...command,
        ...(location === "name"
          ? { name_localizations: { de: "kaufen" } }
          : {}),
        ...(location === "description"
          ? { description_localizations: { de: "Kaufen" } }
          : {}),
        options: command.options?.map((option) => ({
          ...option,
          ...(location === "option-name"
            ? { name_localizations: { de: "objekt" } }
            : {}),
          ...(location === "option-description"
            ? { description_localizations: { de: "Objekt" } }
            : {}),
          choices: option.choices?.map((choice) => ({
            ...choice,
            ...(location === "choice"
              ? { name_localizations: { de: "Sensoren" } }
              : {}),
          })),
        })),
      }));
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
    expect(commandManifest.map((command) => command.name)).toEqual([
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
    ]);
    expect(
      commandManifest.every(
        (command) =>
          command.contexts.join() === "0" &&
          command.integration_types.join() === "0",
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
    f.control.remote = f.control.remote.map((command, index) =>
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
      const delay = yield* Schema.decodeUnknownEffect(RetryAfter)(seconds);
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
          yield* Schema.decodeUnknownEffect(RetryAfter)(value).pipe(
            Effect.result,
          ),
        ),
      ).toBeTrue();
  }),
);

const invalidRetryBodies: ReadonlyArray<
  readonly [string, "rate-limit" | "provider"]
> = [
  ['{"retry_after":0}', "rate-limit"],
  ['{"retry_after":-0.1}', "rate-limit"],
  ['{"retry_after":1e999}', "rate-limit"],
  ['{"retry_after":1e308}', "rate-limit"],
  ['{"retry_after":30}', "rate-limit"],
  ['{"retry_after":"0.001"}', "provider"],
  ['{"retry_after":null}', "provider"],
  ["{}", "provider"],
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
    expect(error.code).toBe("provider");
    expect(error.phase).toBe("before");
    expect(f.control.reads).toBe(0);
    expect(f.control.writes).toBe(0);
    f.control.status = "ready";
    expect((yield* syncCommands(f.release, f.options)).changed).toBeTrue();
    expect(f.control.writes).toBe(1);
  }),
);
