import { writeFile } from "node:fs/promises";

import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import { Effect, Schema, Stream } from "effect";

import Stack from "../alchemy.run.js";
import { CloudResourceEvidence, cloudSettings } from "./cloud-settings.js";
import { PreviewOutput, PreviewStage } from "./preview-identity.js";

const settings = cloudSettings(process.env);

Schema.decodeUnknownSync(PreviewStage)(settings.stage);

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

    const output = yield* Schema.decodeUnknownEffect(PreviewOutput)(deployed);
    yield* Effect.promise(() =>
      writeFile(
        new URL("preview-output.json", directory),
        JSON.stringify(output, null, 2),
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
      namespaces: namespaces
        .filter((namespace) => workers.includes(namespace.script ?? ""))
        .map((namespace) => namespace.id),
    });

    yield* Effect.promise(() =>
      writeFile(
        new URL("resources.json", directory),
        JSON.stringify(evidence, null, 2),
      ),
    );
  }),
  options,
);
