/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/process-env-in-effect -- The fixture or CLI explicitly reads the host environment, rather than the injected application configuration. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { parseArgs } from "node:util";

import { syncCommands } from "@arctools/discord/server";
import { AccountStatus, SetupResult } from "@arctools/twitch/server";
import {
  decodeBody,
  providerTransport,
  readJson,
  request,
} from "@arctools/utils/http";
import {
  Effect,
  Redacted,
  Schema,
  String as EffectString,
  Console as EffectConsole,
} from "effect";
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
        EffectString.startsWith("test-")(stage) &&
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
        yield* EffectConsole.info(
          yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown, { space: 2 }),
          )(setup).pipe(Effect.orDie),
        );
      } else {
        const status = yield* decodeBody(AccountStatus)(result);

        if (status.stage !== stage) return yield* Effect.fail("stage mismatch");
        yield* EffectConsole.info(
          yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown, { space: 2 }),
          )(status).pipe(Effect.orDie),
        );
      }

      if (values.discord) {
        const drift = yield* syncCommands(
          {
            stage,
            endpoint: endpoint.origin,
            revision: yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
              values.revision,
            ),
            applicationId: yield* Schema.decodeUnknownEffect(
              Schema.NonEmptyString,
            )(process.env.DISCORD_APPLICATION_ID),
            token: Redacted.make(
              yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
                process.env.DISCORD_BOT_TOKEN,
              ),
            ),
          },
          { checkOnly: true },
        );

        yield* EffectConsole.info(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            discordDrift: drift.drift,
            manifestHash: drift.hash,
          }).pipe(Effect.orDie),
        );
      }
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This CLI or deployment entry point owns the composed layer scope.
    }).pipe(Effect.provide(providerTransport)),
  );
} catch {
  console.error(
    "Operator command failed. Use setup or status with --stage and --endpoint. Set OPERATOR_SECRET in the environment. Discord drift checks also require --revision and the stage's Discord credentials. Request details are omitted.",
  );
  process.exitCode = 1;
}
