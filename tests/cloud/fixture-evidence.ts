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
      `${JSON.stringify(value)}\n`,
    );
  });
});

export const httpEvidenceSink =
  (directory: URL): import("./fixture-http.js").EvidenceSink =>
  (event) =>
    Effect.promise(async () => {
      console.info(JSON.stringify({ fixtureHttp: event }));

      await mkdir(directory, { recursive: true });
      await appendFile(
        new URL("fixture-http-requests.jsonl", directory),
        `${JSON.stringify(event)}\n`,
      );

      if (event.kind === "cleanup") {
        await mkdir(new URL("journeys/", directory), { recursive: true });
        await appendFile(
          new URL("journeys/fixture-controls.jsonl", directory),
          `${JSON.stringify(event)}\n`,
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
