import { parseArgs } from "node:util";
import { Effect, Redacted, Schema } from "effect";
import { Stage } from "../apps/bot/src/config.js";
import { manifestHash } from "../apps/bot/src/discord-manifest.js";
import { ReleaseHealth, syncCommands } from "../apps/bot/src/discord-sync.js";
import { decodeBody, request } from "../apps/bot/src/provider-http.js";

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
      const hash = yield* manifestHash;
      let ready = false;
      for (let attempt = 0; attempt < (values.wait ? 60 : 1); attempt++) {
        const health = yield* request(`${endpoint.origin}/health`, {}).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? decodeBody(ReleaseHealth, response.body)
              : Effect.succeed(null),
          ),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (
          health?.stage === stage &&
          health.revision === revision &&
          health.manifestHash === hash
        ) {
          ready = true;
          break;
        }
        if (values.wait && attempt < 59) yield* Effect.sleep(1000);
      }
      if (!ready) return yield* Effect.fail("deployed revision mismatch");
      const result = yield* syncCommands({
        stage,
        revision,
        endpoint: endpoint.origin,
        applicationId,
        token,
      });
      console.info(JSON.stringify({ stage, revision, ...result }));
    }),
  );
} catch {
  console.error(
    "Discord synchronization failed. Deployment may have succeeded while registration remains incomplete. Check the selected stage, exact revision/manifest health, application credentials and provider status. Request details are omitted.",
  );
  process.exitCode = 1;
}
