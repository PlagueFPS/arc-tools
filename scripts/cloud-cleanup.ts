import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { State } from "alchemy/State";
import * as Core from "alchemy/Test/Core";
import { Effect, Schema, Stream } from "effect";

import Stack from "../alchemy.run.js";
import { CloudResourceEvidence, cloudSettings } from "./cloud-settings.js";

const settings = cloudSettings(process.env);

const resourceFile = new URL(
  `../.cloud-tests/${settings.stage}/resources.json`,
  import.meta.url,
);

const evidence = existsSync(resourceFile)
  ? Schema.decodeUnknownSync(CloudResourceEvidence)(
      JSON.parse(await readFile(resourceFile, "utf8")),
    )
  : { stage: settings.stage, workers: [], namespaces: [] };

if (evidence.stage !== settings.stage)
  throw new Error("Cleanup resource journal stage mismatch");

const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: settings.stage,
  profile: settings.profile,
};

await Core.run(
  Effect.gen(function* () {
    yield* Core.destroy(options, Stack);
    const state = yield* yield* State;

    const remaining = yield* state.list({
      stack: Stack.stackName,
      stage: settings.stage,
    });

    const output = yield* state.getOutput({
      stack: Stack.stackName,
      stage: settings.stage,
    });

    if (remaining.length !== 0 || output !== undefined) {
      return yield* Effect.fail(
        new Error(
          `Cleanup left ${remaining.length} state entries for ${settings.stage}`,
        ),
      );
    }

    yield* Core.withProviders(
      Effect.gen(function* () {
        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

        const names = [
          `arc-tools-bot-${settings.stage}`,
          `arc-tools-probe-${settings.stage}`,
          `arc-tools-cache-${settings.stage}`,
          `arc-tools-metaforge-${settings.stage}`,
          `arc-tools-account-${settings.stage}`,
          `arc-tools-provider-${settings.stage}`,
          `arc-tools-tenant-${settings.stage}`,
          ...evidence.workers,
        ];

        const workers = yield* Workers.listScripts
          .items({ accountId })
          .pipe(Stream.runCollect);

        const namespaces = yield* DurableObjects.listNamespaces
          .items({ accountId })
          .pipe(Stream.runCollect);

        const remainingWorkers = workers.filter((worker) =>
          names.includes(worker.id ?? ""),
        );

        const remainingObjects = namespaces.filter(
          (namespace) =>
            names.includes(namespace.script ?? "") ||
            evidence.namespaces.includes(namespace.id ?? ""),
        );

        if (remainingWorkers.length || remainingObjects.length) {
          return yield* Effect.fail(
            new Error(
              `Cloudflare still lists ${remainingWorkers.length} Workers and ${remainingObjects.length} namespaces for ${settings.stage}`,
            ),
          );
        }

        console.info(
          `CLEANUP VERIFIED ${settings.stage}: Cloudflare lists 0 Workers and 0 DO namespaces; state entries and output absent; control backend retained`,
        );
      }),
      options,
      Stack.stackName,
    );
  }),
  options,
);
