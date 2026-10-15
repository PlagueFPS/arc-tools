import { Config, Effect, Schema } from "effect";

export const TestStage = Schema.String.check(
  Schema.isPattern(/^test-[a-z0-9-]{1,24}-[a-f0-9]{12}$/),
);
export const Stage = Schema.Union([
  Schema.Literals(["prod", "staging"]),
  Schema.String.check(Schema.isPattern(/^local-[a-z0-9-]+$/)),
  TestStage,
]);
const login = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,25}$/));
const application = Schema.NonEmptyString;
const common = {
  applicationStage: Stage,
  twitchClientId: application,
  discordApplicationId: application,
};
export const EnvironmentConfig = Schema.Union([
  Schema.Struct({
    ...common,
    kind: Schema.Literal("production"),
    stage: Schema.Literal("prod"),
    senderKind: Schema.Literal("bot"),
    senderLogin: login,
    channelLogins: Schema.NonEmptyArray(login),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("personal"),
    stage: Schema.Union([
      Schema.Literal("staging"),
      Schema.String.check(Schema.isPattern(/^local-[a-z0-9-]+$/)),
    ]),
    senderKind: Schema.Literal("personal"),
    senderLogin: login,
    channelLogins: Schema.Tuple([login]),
  }).check(
    Schema.makeFilter((value) => value.channelLogins[0] === value.senderLogin),
  ),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("test"),
    stage: TestStage,
    senderKind: Schema.Literal("synthetic"),
    senderLogin: Schema.Literal("fixture_sender"),
    channelLogins: Schema.NonEmptyArray(
      Schema.String.check(Schema.isPattern(/^fixture_[a-z0-9_]{1,17}$/)),
    ).check(Schema.isMaxLength(32)),
    twitchClientId: Schema.Literal("fixture-twitch"),
    discordApplicationId: Schema.Literal("fixture-discord"),
  }),
]).check(Schema.makeFilter((value) => value.applicationStage === value.stage));
export type EnvironmentConfig = typeof EnvironmentConfig.Type;

export const runtimeConfig = Effect.gen(function* () {
  const stage = yield* Config.schema(Stage, "ARC_STAGE");
  const applicationStage = yield* Config.schema(Stage, "APPLICATION_STAGE");
  const kind = yield* Config.Literals(
    ["production", "personal", "test"],
    "ARC_ENVIRONMENT",
  );
  const senderKind = yield* Config.Literals(
    ["bot", "personal", "synthetic"],
    "TWITCH_SENDER_KIND",
  );
  const senderLogin = yield* Config.String("TWITCH_SENDER_LOGIN");
  const channelLogins = yield* Config.Array(
    Schema.String,
    "TWITCH_CHANNEL_LOGINS",
  );
  const twitchClientId = yield* Config.NonEmptyString("TWITCH_CLIENT_ID");
  const discordApplicationId = yield* Config.NonEmptyString(
    "DISCORD_APPLICATION_ID",
  );
  const twitchClientSecret = yield* Config.Redacted("TWITCH_CLIENT_SECRET");
  const twitchSigningSecret = yield* Config.Redacted("TWITCH_SIGNING_SECRET");
  const discordBotToken = yield* Config.Redacted("DISCORD_BOT_TOKEN");
  const discordPublicKey = yield* Config.NonEmptyString("DISCORD_PUBLIC_KEY");
  const operatorSecret = yield* Config.Redacted("OPERATOR_SECRET");
  const identity = yield* Schema.decodeUnknownEffect(EnvironmentConfig)({
    stage,
    applicationStage,
    kind,
    senderKind,
    senderLogin,
    channelLogins,
    twitchClientId,
    discordApplicationId,
  }).pipe(Effect.orDie);
  return {
    identity,
    twitchClientSecret,
    twitchSigningSecret,
    discordBotToken,
    discordPublicKey,
    operatorSecret,
  };
});

export const accountRuntimeConfig = Effect.gen(function* () {
  const config = yield* runtimeConfig;
  const publicUrl = yield* Config.String("ARC_PUBLIC_URL").pipe(
    Config.withDefault(""),
  );
  return {
    ...config,
    publicUrl: publicUrl.replace(/\/$/, ""),
    webhookReady: false,
  };
});

export const buildRevision = Config.String("ARC_BUILD_REVISION").pipe(
  Config.withDefault("unreleased"),
);
