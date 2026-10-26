import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";

import * as Cloudflare from "@alchemy.run/cloudflare";
import { manifestHash } from "@arctools/discord/server";
import { State, localState } from "alchemy/State";
import * as Test from "alchemy/Test/Bun";
import { Effect, Schedule, Schema } from "effect";

import { makeStack } from "../../alchemy.run.js";
import {
  LocalTestResources,
  localTestSettings,
} from "../../scripts/local-test-settings.js";
import { installHttpEvidence } from "./fixture-evidence.js";
import {
  get,
  json,
  post,
  reconstructedSnapshot,
  registerLocalFixture,
  request,
} from "./fixture-http.js";
import { ProbeSnapshot } from "./probe.js";

const settings = localTestSettings(process.env);

installHttpEvidence();

const options = {
  providers: Cloudflare.providers(),
  state: localState(),
  dev: true,
  stage: settings.stage,
  profile: settings.profile,
};

const Stack = makeStack(options);

export const { test, beforeAll, afterAll, deploy, destroy } =
  Test.make(options);

export const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          url: Schema.String,
          probeUrl: Schema.String,
          workerName: Schema.String,
          probeWorkerName: Schema.String,
          cacheUrl: Schema.optional(Schema.String),
          cacheWorkerName: Schema.optional(Schema.String),
          sourceUrl: Schema.optional(Schema.String),
          sourceWorkerName: Schema.optional(Schema.String),
          accountUrl: Schema.optional(Schema.String),
          accountWorkerName: Schema.optional(Schema.String),
          tenantUrl: Schema.optional(Schema.String),
          tenantWorkerName: Schema.optional(Schema.String),
          providerUrl: Schema.optional(Schema.String),
          providerWorkerName: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  { timeout: 240_000 },
);

beforeAll(
  Effect.fn("Local fixture startup and provider state")(function* () {
    const deployed = yield* stack;

    const resources = Schema.decodeUnknownSync(LocalTestResources)({
      stage: settings.stage,
      origins: Object.entries(deployed)
        .filter(([key]) => key.endsWith("Url") || key === "url")
        .map(([, value]) => value),
    });

    yield* Effect.promise(() =>
      writeFile(
        new URL(
          `../../.cloud-tests/${settings.stage}/resources.json`,
          import.meta.url,
        ),
        JSON.stringify(resources, null, 2),
      ),
    );
    yield* get(`${deployed.probeUrl}/snapshot`, ProbeSnapshot);

    if (deployed.providerUrl)
      registerLocalFixture("provider", deployed.providerUrl);

    if (deployed.accountUrl)
      registerLocalFixture("account", deployed.accountUrl);

    if (deployed.cacheUrl) registerLocalFixture("cache", deployed.cacheUrl);

    if (deployed.sourceUrl)
      registerLocalFixture("metaforge", deployed.sourceUrl);

    if (deployed.tenantUrl) registerLocalFixture("tenant", deployed.tenantUrl);
    const state = yield* yield* State;

    expect(state.id).toBe("local");

    const resourceNames = yield* state.list({
      stack: Stack.stackName,
      stage: settings.stage,
    });

    expect(resourceNames.length).toBeGreaterThan(0);

    for (const fqn of resourceNames) {
      const resource = yield* state.get({
        stack: Stack.stackName,
        stage: settings.stage,
        fqn,
      });

      expect(
        resource && "providerMode" in resource
          ? resource.providerMode
          : undefined,
      ).toBe("local");
    }

    for (const [key, value] of Object.entries(deployed)) {
      if (key.endsWith("Url") || key === "url") {
        expect(new URL(value).hostname).toBe("localhost");
      }
    }
  })(),
  { timeout: 90_000 },
);

afterAll(
  destroy(Stack).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const state = yield* yield* State;
        expect(
          yield* state.list({ stack: Stack.stackName, stage: settings.stage }),
        ).toEqual([]);
        expect(
          yield* state.getOutput({
            stack: Stack.stackName,
            stage: settings.stage,
          }),
        ).toBeUndefined();
      }),
    ),
  ),
  { timeout: 180_000 },
);

const snapshot = (url: string) => get(`${url}/snapshot`, ProbeSnapshot);

test(
  "raw HttpApi preserves every byte before JSON decoding",
  Effect.gen(function* () {
    const { probeUrl: url } = yield* stack;
    expect((yield* request(`${url}/health`)).status).toBe(200);
    const application = yield* stack;
    const health = yield* request(`${application.url}/health`);
    expect(health.status).toBe(200);
    expect(yield* Effect.promise(() => health.json())).toEqual({
      status: "ready",
      stage: settings.stage,
      revision: "unreleased",
      manifestHash: yield* manifestHash,
    });

    const bytes = new Uint8Array([
      0, 255, 13, 10, 32, 123, 34, 120, 34, 58, 49, 125, 10,
    ]);

    const response = yield* request(`${url}/raw`, {
      method: "POST",
      body: bytes,
    });

    expect(response.status).toBe(200);
    expect(
      new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
    ).toEqual(bytes);
  }),
  { timeout: 90_000 },
);

test(
  "SQLite, KV and alarm changes roll back and survive object reconstruction",
  Effect.gen(function* () {
    const { probeUrl: url } = yield* stack;
    const response = yield* post(`${url}/prepare`);
    expect(response.status).toBe(200);

    const result = yield* json(
      response,
      Schema.Struct({
        rolledBack: Schema.Boolean,
        before: Schema.Number,
        snapshot: ProbeSnapshot,
      }),
    );

    expect(result.rolledBack).toBeTrue();
    expect(result.snapshot.value).toBe("committed");
    expect(result.snapshot.attempts).toBe(0);
    expect(result.snapshot.alarm).toBe(result.before);
    expect((yield* post(`${url}/reset`)).status).toBe(204);

    const reconstructed = yield* reconstructedSnapshot(
      snapshot(url),
      result.snapshot.instance,
    );

    expect(reconstructed.instance).not.toBe(result.snapshot.instance);
    expect(reconstructed.value).toBe("committed");
    expect(reconstructed.attempts).toBe(0);
    expect(reconstructed.alarm).toBe(result.before);
  }),
  { timeout: 90_000 },
);

test(
  "persisted alarm retries on workerd after an intentional first failure",
  Effect.gen(function* () {
    const { probeUrl: url } = yield* stack;
    const response = yield* post(`${url}/arm`);
    expect(response.status).toBe(200);
    const armed = yield* json(response, ProbeSnapshot);
    expect(armed.attempts).toBe(0);
    expect(armed.completed).toBeFalse();
    expect(armed.alarm).toBeNumber();
    expect((yield* post(`${url}/reset`)).status).toBe(204);

    const reconstructed = yield* reconstructedSnapshot(
      snapshot(url),
      armed.instance,
    );

    expect(reconstructed.instance).not.toBe(armed.instance);

    const observationBudgetMs = 120_000;
    let completed = reconstructed;

    const record = () => ({
      observationBudgetMs,
      observedAt: Date.now(),
      armed,
      reconstructed,
      final: completed,
    });

    yield* snapshot(url).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          completed = value;
        }),
      ),
      Effect.repeat({
        until: (value) => value.completed,
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.timeoutOption(observationBudgetMs),
      Effect.ensuring(
        Effect.promise(() =>
          writeFile(
            new URL(
              `../../.cloud-tests/${settings.stage}/alarm-observation.json`,
              import.meta.url,
            ),
            JSON.stringify(record(), null, 2),
          ),
        ),
      ),
    );

    yield* Effect.logInfo("alarm-retry-observation", record());
    expect(completed.completed).toBeTrue();
    expect(completed.attempts).toBe(2);
    expect(completed.retryCount).toBe(1);
    expect(
      completed.invocations.map(({ attempt, retryCount }) => ({
        attempt,
        retryCount,
      })),
    ).toEqual([
      { attempt: 1, retryCount: 0 },
      { attempt: 2, retryCount: 1 },
    ]);
    expect(completed.alarm).toBeNull();
  }),
  { timeout: 150_000 },
);

if (
  settings.stage.startsWith("test-cache-") ||
  settings.stage.startsWith("test-account-") ||
  settings.stage.startsWith("test-tenant-")
) {
  const { registerCacheTests } = await import("./cache-cases.js");
  registerCacheTests({ stack, test });
}

if (
  settings.stage.startsWith("test-account-") ||
  settings.stage.startsWith("test-tenant-")
) {
  const { registerAccountTests } = await import("./account-cases.js");
  registerAccountTests({ stack, test });
}

if (settings.stage.startsWith("test-tenant-")) {
  const { registerTenantTests } = await import("./tenant-cases.js");
  registerTenantTests({ stack, test });
}
