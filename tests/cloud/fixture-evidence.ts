/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/global-console-in-effect -- The fixture captures native console output at a synchronous host callback boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/process-env-in-effect -- The fixture or CLI explicitly reads the host environment, rather than the injected application configuration. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { appendFile, mkdir } from "node:fs/promises";

import { Effect, Schema } from "effect";

import { setFixtureHttpEvidenceSink } from "./fixture-http.js";

export const retainJourney = Effect.fnUntraced(function* (
  journey: string,
  value: Schema.Json,
) {
  if (!/^[a-z][a-z0-9-]{0,100}$/.test(journey))
    return yield* Effect.die("Invalid evidence journey");

  const directory = new URL(
    `../../.cloud-tests/${process.env.ARC_CLOUD_STAGE}/journeys/`,
    import.meta.url,
  );

  yield* Effect.promise(async () => {
    await mkdir(directory, { recursive: true });
    await appendFile(
      new URL(`${journey}.jsonl`, directory),
      `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)}\n`,
    );
  });
});

export const httpEvidenceSink =
  (directory: URL): import("./fixture-http.js").EvidenceSink =>
  (event) =>
    Effect.promise(async () => {
      console.info(
        Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
          fixtureHttp: event,
        }),
      );

      await mkdir(directory, { recursive: true });
      await appendFile(
        new URL("fixture-http-requests.jsonl", directory),
        `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(event)}\n`,
      );

      if (event.kind === "cleanup") {
        await mkdir(new URL("journeys/", directory), { recursive: true });
        await appendFile(
          new URL("journeys/fixture-controls.jsonl", directory),
          `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(event)}\n`,
        );
      }
    }).pipe(Effect.orDie);

export const installHttpEvidence = () =>
  setFixtureHttpEvidenceSink(
    httpEvidenceSink(
      new URL(
        `../../.cloud-tests/${process.env.ARC_CLOUD_STAGE}/`,
        import.meta.url,
      ),
    ),
  );
