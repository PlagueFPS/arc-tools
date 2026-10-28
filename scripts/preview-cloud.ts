/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { writeFile } from "node:fs/promises";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Core from "alchemy/Test/Core";
import { Effect, Schema, Stream, Array as Arr } from "effect";

import Stack from "../alchemy.run.js";
import { CloudResourceEvidence, cloudSettings } from "./cloud-settings.js";
import { PreviewOutput, PreviewStage } from "./preview-identity.js";

const settings = cloudSettings(process.env);

Schema.decodeSync(PreviewStage)(settings.stage);

const directory = new URL(
  `../.cloud-tests/${settings.stage}/`,
  import.meta.url,
);

const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: settings.stage,
  profile: settings.profile,
  dev: false,
};

await Core.run(
  Effect.gen(function* () {
    const deployed = yield* Core.deploy(options, Stack).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            ...PreviewOutput.fields,
            workerName: Schema.NonEmptyString,
            probeWorkerName: Schema.NonEmptyString,
            cacheWorkerName: Schema.NonEmptyString,
            sourceWorkerName: Schema.NonEmptyString,
            accountWorkerName: Schema.NonEmptyString,
            providerWorkerName: Schema.NonEmptyString,
            tenantWorkerName: Schema.NonEmptyString,
          }),
        ),
      ),
    );

    const output = yield* Schema.decodeEffect(PreviewOutput)(deployed);
    yield* Effect.promise(() =>
      writeFile(
        new URL("preview-output.json", directory),
        Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
          output,
        ),
      ),
    );

    const workers = [
      deployed.workerName,
      deployed.probeWorkerName,
      deployed.cacheWorkerName,
      deployed.sourceWorkerName,
      deployed.accountWorkerName,
      deployed.providerWorkerName,
      deployed.tenantWorkerName,
    ];

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

    const evidence = yield* Schema.decodeUnknownEffect(CloudResourceEvidence)({
      stage: settings.stage,
      workers,
      namespaces: Arr.map(
        Arr.filter(
          namespaces,
          (namespace) => !!workers.includes(namespace.script ?? ""),
        ),
        (namespace) => namespace.id,
      ),
    });

    yield* Effect.promise(() =>
      writeFile(
        new URL("resources.json", directory),
        Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
          evidence,
        ),
      ),
    );
  }),
  options,
);
