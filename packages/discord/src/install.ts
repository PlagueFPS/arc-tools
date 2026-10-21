import { Effect, Schema } from "effect";

const ApplicationId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[1-9][0-9]{0,19}$/),
).pipe(
  Schema.decodeTo(
    Schema.BigIntFromString.check(
      Schema.isLessThanOrEqualToBigInt(18446744073709551615n),
    ),
  ),
);

const InstallInput = Schema.Struct({ applicationId: ApplicationId });

export class DiscordInstallError extends Schema.TaggedError<DiscordInstallError>()(
  "DiscordInstallError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const guildInstallUrl = Effect.fnUntraced(function* (
  input: typeof InstallInput.Encoded,
) {
  const { applicationId } = yield* Schema.decodeUnknownEffect(InstallInput)(
    input,
  ).pipe(
    Effect.catchTag(
      "SchemaError",
      (cause) =>
        new DiscordInstallError({
          message: "Discord application ID must be a positive snowflake",
          cause,
        }),
    ),
  );

  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: applicationId.toString(),
    scope: "bot applications.commands",
    integration_type: "0",
    permissions: "0",
  }).toString();

  return url.toString();
});
