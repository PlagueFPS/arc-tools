import { parseArgs } from "node:util";

import { syncCommands } from "@arctools/discord/server";
import { AccountStatus, SetupResult } from "@arctools/twitch/server";
import {
  decodeBody,
  providerTransport,
  readJson,
  request,
} from "@arctools/utils/http";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Stage } from "../apps/bot/src/config.js";

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
    (endpoint.protocol !== "https:" &&
      !(
        stage.startsWith("test-") &&
        endpoint.protocol === "http:" &&
        endpoint.hostname === "localhost"
      )) ||
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
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatus((status) => status === 200),
      );

      const result = yield* request(
        client,
        HttpClientRequest.post(`${endpoint.origin}/ops/${operation}`, {
          headers: {
            Authorization: `Bearer ${operator}`,
          },
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ stage })),
        readJson,
        30_000,
      );

      if (operation === "setup") {
        const setup = yield* decodeBody(SetupResult)(result);

        if (setup.status.stage !== stage)
          return yield* Effect.fail("stage mismatch");
        console.info(JSON.stringify(setup, null, 2));
      } else {
        const status = yield* decodeBody(AccountStatus)(result);

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
    }).pipe(Effect.provide(providerTransport)),
  );
} catch {
  console.error(
    "Operator command failed. Use setup or status with --stage and --endpoint. Set OPERATOR_SECRET in the environment. Discord drift checks also require --revision and the stage's Discord credentials. Request details are omitted.",
  );
  process.exitCode = 1;
}
