import { Effect, Schema } from "effect";
import { requestJson } from "../src/platform.ts";
import { provisionDiscord, provisionTwitch } from "../src/provision.ts";

const mode = Bun.argv[2];
const required = (name: string) =>
  Schema.decodeUnknownSync(Schema.NonEmptyString)(Bun.env[name]);
const run = Effect.gen(function* () {
  if (mode === "discord") {
    const registered = yield* provisionDiscord({
      applicationId: required("DISCORD_APPLICATION_ID"),
      botToken: required("DISCORD_BOT_TOKEN"),
    });
    yield* Effect.logInfo(
      `Registered ${registered.length} global guild slash commands`,
    );
  } else if (mode === "twitch") {
    const clientId = required("TWITCH_CLIENT_ID");
    const token = yield* requestJson("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: required("TWITCH_CLIENT_SECRET"),
        grant_type: "client_credentials",
      }).toString(),
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.NonEmptyString }),
        ),
      ),
    );
    const result = yield* provisionTwitch({
      clientId,
      appToken: token.access_token,
      botId: required("TWITCH_BOT_USER_ID"),
      channels: required("TWITCH_CHANNEL_IDS")
        .split(",")
        .map((id) => id.trim()),
      callback: required("TWITCH_CALLBACK_URL"),
      secret: required("TWITCH_WEBHOOK_SECRET"),
      recreate: Bun.argv.includes("--recreate"),
    });
    yield* Effect.logInfo(
      `Reconciled subscriptions, created ${result.created}, deleted ${result.deleted}`,
    );
  } else throw new Error("Usage: bun scripts/provision.ts discord|twitch");
});
const exit = await Effect.runPromiseExit(run);
if (exit._tag === "Failure") {
  process.stderr.write(
    "Provisioning failed. Check configuration, authorization grants, and endpoint availability.\n",
  );
  process.exitCode = 1;
}
