/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/global-console-in-effect -- The fixture captures native console output at a synchronous host callback boundary. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { parseArgs } from "node:util";

import {
  preflightCommands,
  syncCommands,
  syncDiagnostic,
  waitForRelease,
} from "@arctools/discord/server";
import { providerTransport } from "@arctools/utils/http";
import { Effect, Redacted, Schema, Console as EffectConsole } from "effect";

import { Stage } from "../apps/bot/src/config.js";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      stage: { type: "string" },
      endpoint: { type: "string" },
      revision: { type: "string" },
      wait: { type: "boolean" },
      preflight: { type: "boolean" },
    },
  });

  const stage = Schema.decodeUnknownSync(Stage)(values.stage);

  const revision = Schema.decodeUnknownSync(Schema.NonEmptyString)(
    values.revision,
  );

  const endpoint = new URL(values.endpoint ?? "");

  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("endpoint");

  const applicationId = Schema.decodeUnknownSync(Schema.NonEmptyString)(
    process.env.DISCORD_APPLICATION_ID,
  );

  const token = Redacted.make(
    Schema.decodeUnknownSync(Schema.NonEmptyString)(
      process.env.DISCORD_BOT_TOKEN,
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      if (values.preflight) {
        yield* preflightCommands({ applicationId, token });
        yield* EffectConsole.info(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            event: "discord-preflight-success",
            stage,
            revision,
          }).pipe(Effect.orDie),
        );

        return;
      }

      yield* waitForRelease(
        { stage, revision, endpoint: endpoint.origin },
        values.wait,
      );

      const result = yield* syncCommands({
        stage,
        revision,
        endpoint: endpoint.origin,
        applicationId,
        token,
      });

      yield* EffectConsole.info(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          stage,
          revision,
          ...result,
        }).pipe(Effect.orDie),
      );
    }).pipe(
      Effect.catchTag("SyncError", (error) =>
        Effect.sync(() => {
          console.error(
            Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
              syncDiagnostic(error),
            ),
          );
          process.exitCode = 1;
        }),
      ),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This CLI or deployment entry point owns the composed layer scope.
      Effect.provide(providerTransport),
    ),
  );
} catch {
  console.error(
    JSON.stringify({
      event: "discord-sync-failure",
      code: "configuration-or-runtime",
    }),
  );
  process.exitCode = 1;
}
