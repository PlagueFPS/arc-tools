import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Core from "alchemy/Test/Core";
import { Effect, Schedule, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import Stack from "../../alchemy.run.js";
import {
  CloudResourceEvidence,
  cloudSettings,
} from "../../scripts/cloud-settings.js";
import { ProbeSnapshot } from "./probe.js";

const settings = cloudSettings(process.env);
const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: settings.stage,
  profile: settings.profile,
};
const { test, beforeAll, afterAll, deploy, destroy } = Test.make(options);

const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          url: Schema.String,
          probeUrl: Schema.String,
          workerName: Schema.String,
          probeWorkerName: Schema.String,
        }),
      ),
    ),
  ),
  { timeout: 180_000 },
);

beforeAll(
  Effect.gen(function* () {
    const deployed = yield* stack;
    const ready = yield* HttpClient.get(`${deployed.probeUrl}/snapshot`).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : response.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(
                  new Error(`Probe activation ${response.status}: ${body}`),
                ),
              ),
            ),
      ),
      Effect.retry({ times: 6, schedule: Schedule.spaced("1 second") }),
    );
    expect(ready.status).toBe(200);
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
    const evidence = yield* Schema.decodeUnknownEffect(CloudResourceEvidence)({
      stage: settings.stage,
      workers: [deployed.workerName, deployed.probeWorkerName],
      namespaces: probeNamespaces.map((namespace) => namespace.id),
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
  { timeout: 60_000 },
);

afterAll(destroy(Stack), { timeout: 180_000 });

const snapshot = Effect.fn(function* (url: string) {
  const response = yield* Test.getWhenReady(`${url}/snapshot`, { times: 4 });
  expect(response.status).toBe(200);
  return yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProbeSnapshot)),
  );
});

test(
  "raw HttpApi preserves every byte before JSON decoding",
  Effect.gen(function* () {
    const { probeUrl: url } = yield* stack;
    expect(
      (yield* Test.getWhenReady(`${url}/health`, { times: 6 })).status,
    ).toBe(200);
    const application = yield* stack;
    const health = yield* Test.getWhenReady(`${application.url}/health`, {
      times: 6,
    });
    expect(yield* health.json).toEqual({
      status: "foundation",
      stage: settings.stage,
    });
    const bytes = new Uint8Array([
      0, 255, 13, 10, 32, 123, 34, 120, 34, 58, 49, 125, 10,
    ]);
    const response = yield* Effect.promise(() =>
      fetch(`${url}/raw`, { method: "POST", body: bytes }),
    );
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
    const response = yield* HttpClient.post(`${url}/prepare`);
    expect(response.status).toBe(200);
    const result = yield* response.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            rolledBack: Schema.Boolean,
            before: Schema.Number,
            snapshot: ProbeSnapshot,
          }),
        ),
      ),
    );
    expect(result.rolledBack).toBeTrue();
    expect(result.snapshot.value).toBe("committed");
    expect(result.snapshot.attempts).toBe(0);
    expect(result.snapshot.alarm).toBe(result.before);
    yield* HttpClient.post(`${url}/reset`);
    const reconstructed = yield* snapshot(url).pipe(Effect.retry({ times: 3 }));
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
    const armed = yield* (yield* HttpClient.post(`${url}/arm`)).json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProbeSnapshot)),
    );
    expect(armed.attempts).toBe(0);
    expect(armed.completed).toBeFalse();
    expect(armed.alarm).toBeNumber();
    yield* HttpClient.post(`${url}/reset`);
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
