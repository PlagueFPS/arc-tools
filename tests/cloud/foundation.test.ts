import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Core from "alchemy/Test/Core";
import { Effect, Schedule, Schema, Stream } from "effect";
import Stack from "../../alchemy.run.js";
import { manifestHash } from "../../apps/bot/src/discord-manifest.js";
import {
  CloudResourceEvidence,
  cloudSettings,
} from "../../scripts/cloud-settings.js";
import {
  get,
  json,
  post,
  reconstructedSnapshot,
  request,
} from "./fixture-http.js";
import { ProbeSnapshot } from "./probe.js";

const settings = cloudSettings(process.env);
const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: settings.stage,
  profile: settings.profile,
};
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
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* get(`${deployed.probeUrl}/snapshot`, ProbeSnapshot);
    const namespaces = yield* Core.withProviders(
      Effect.gen(function* () {
        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
        return yield* DurableObjects.listNamespaces
          .items({ accountId })
          .pipe(Stream.runCollect);
      }),
      options,
      Stack.stackName,
    );
    const probeNamespaces = namespaces.filter(
      (namespace) => namespace.script === deployed.probeWorkerName,
    );
    expect(probeNamespaces.length).toBe(1);
    expect(probeNamespaces[0]?.useSqlite).toBeTrue();
    const workerNames = [
      deployed.workerName,
      deployed.probeWorkerName,
      ...[
        deployed.cacheWorkerName,
        deployed.sourceWorkerName,
        deployed.accountWorkerName,
        deployed.providerWorkerName,
        deployed.tenantWorkerName,
      ].filter((name) => name !== undefined),
    ];
    const stackNamespaces = namespaces.filter((namespace) =>
      workerNames.includes(namespace.script ?? ""),
    );
    if (settings.stage.startsWith("test-cache-")) {
      expect(stackNamespaces.length).toBe(6);
      expect(
        stackNamespaces.every((namespace) => namespace.useSqlite),
      ).toBeTrue();
    }
    if (settings.stage.startsWith("test-account-")) {
      expect(stackNamespaces.length).toBe(8);
      expect(
        stackNamespaces.every((namespace) => namespace.useSqlite),
      ).toBeTrue();
    }
    if (settings.stage.startsWith("test-tenant-")) {
      expect(stackNamespaces.length).toBe(10);
      expect(
        stackNamespaces.every((namespace) => namespace.useSqlite),
      ).toBeTrue();
    }
    const evidence = yield* Schema.decodeUnknownEffect(CloudResourceEvidence)({
      stage: settings.stage,
      workers: workerNames,
      namespaces: stackNamespaces.map((namespace) => namespace.id),
    });
    yield* Effect.promise(() =>
      writeFile(
        new URL(
          `../../.cloud-tests/${settings.stage}/resources.json`,
          import.meta.url,
        ),
        JSON.stringify(evidence, null, 2),
      ),
    );
  }),
  { timeout: 90_000 },
);

afterAll(destroy(Stack), { timeout: 180_000 });

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
      status: "foundation",
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
  "persisted alarm retries on Cloudflare after an intentional first failure",
  Effect.gen(function* () {
    const { probeUrl: url } = yield* stack;
    const response = yield* post(`${url}/arm`);
    expect(response.status).toBe(200);
    const armed = yield* json(response, ProbeSnapshot);
    expect(armed.attempts).toBe(0);
    expect(armed.completed).toBeFalse();
    expect(armed.alarm).toBeNumber();
    expect((yield* post(`${url}/reset`)).status).toBe(204);
    expect(
      (yield* reconstructedSnapshot(snapshot(url), armed.instance)).instance,
    ).not.toBe(armed.instance);
    const completed = yield* snapshot(url).pipe(
      Effect.repeat({
        until: (value) => value.completed,
        times: 30,
        schedule: Schedule.spaced("1 second"),
      }),
    );
    expect(completed.completed).toBeTrue();
    expect(completed.attempts).toBe(2);
    expect(completed.retryCount).toBe(1);
    expect(completed.alarm).toBeNull();
  }),
  { timeout: 60_000 },
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
