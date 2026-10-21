import { parseArgs } from "node:util";

import { syncCommands, waitForRelease } from "@arctools/discord/server";
import { providerTransport } from "@arctools/utils/http";
import { Effect, Redacted, Schema } from "effect";

import { Stage } from "../apps/bot/src/config.js";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      stage: { type: "string" },
      endpoint: { type: "string" },
      revision: { type: "string" },
      wait: { type: "boolean" },
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
      const ready = yield* waitForRelease(
        { stage, revision, endpoint: endpoint.origin },
        values.wait,
      );

      if (!ready) return yield* Effect.fail("deployed revision mismatch");

      const result = yield* syncCommands({
        stage,
        revision,
        endpoint: endpoint.origin,
        applicationId,
        token,
      });

      console.info(JSON.stringify({ stage, revision, ...result }));
    }).pipe(Effect.provide(providerTransport)),
  );
} catch {
  console.error(
    "Discord synchronization failed. Deployment may have succeeded while registration remains incomplete. Check the selected stage, exact revision/manifest health, application credentials and provider status. Request details are omitted.",
  );
  process.exitCode = 1;
}
