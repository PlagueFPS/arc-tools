import { parseArgs } from "node:util";
import { Effect, Redacted, Schema } from "effect";
import { Stage } from "../apps/bot/src/config.js";
import { syncCommands } from "../apps/bot/src/discord-sync.js";
import { decodeBody, request } from "../apps/bot/src/provider-http.js";
import {
  AccountStatus,
  SetupResult,
} from "../apps/bot/src/twitch-contracts.js";

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      endpoint: { type: "string" },
      discord: { type: "boolean" },
      revision: { type: "string" },
    },
  });
  const operation = Schema.decodeUnknownSync(
    Schema.Literals(["setup", "status"]),
  )(positionals[0]);
  const stage = Schema.decodeUnknownSync(Stage)(values.stage);
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
  const operator = Schema.decodeUnknownSync(Schema.NonEmptyString)(
    process.env.OPERATOR_SECRET,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* request(
        `${endpoint.origin}/ops/${operation}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${operator}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stage }),
        },
        30_000,
      );
      if (result.status !== 200)
        return yield* Effect.fail("operator request failed");
      if (operation === "setup") {
        const setup = yield* decodeBody(SetupResult, result.body);
        if (setup.status.stage !== stage)
          return yield* Effect.fail("stage mismatch");
        console.info(JSON.stringify(setup, null, 2));
      } else {
        const status = yield* decodeBody(AccountStatus, result.body);
        if (status.stage !== stage) return yield* Effect.fail("stage mismatch");
        console.info(JSON.stringify(status, null, 2));
      }
      if (values.discord) {
        const drift = yield* syncCommands(
          {
            stage,
            endpoint: endpoint.origin,
            revision: Schema.decodeUnknownSync(Schema.NonEmptyString)(
              values.revision,
            ),
            applicationId: Schema.decodeUnknownSync(Schema.NonEmptyString)(
              process.env.DISCORD_APPLICATION_ID,
            ),
            token: Redacted.make(
              Schema.decodeUnknownSync(Schema.NonEmptyString)(
                process.env.DISCORD_BOT_TOKEN,
              ),
            ),
          },
          { checkOnly: true },
        );
        console.info(
          JSON.stringify({
            discordDrift: drift.drift,
            manifestHash: drift.hash,
          }),
        );
      }
    }),
  );
} catch {
  console.error(
    "Operator command failed. Use setup or status with --stage and --endpoint. Set OPERATOR_SECRET in the environment. Discord drift checks also require --revision and the stage's Discord credentials. Request details are omitted.",
  );
  process.exitCode = 1;
}
