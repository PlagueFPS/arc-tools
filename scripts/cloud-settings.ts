import { Schema } from "effect";

import { TestStage } from "../apps/bot/src/config.js";

export const CloudSettings = Schema.Struct({
  stage: TestStage,
  run: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/)),
  profile: Schema.NonEmptyString,
}).check(Schema.makeFilter((value) => value.stage.endsWith(`-${value.run}`)));

export type CloudSettings = typeof CloudSettings.Type;

export function cloudSettings(env: NodeJS.ProcessEnv): CloudSettings {
  for (const key of ["ALCHEMY_DEV", "ALCHEMY_TEST_DEV"]) {
    if (env[key] !== undefined && env[key] !== "false" && env[key] !== "0") {
      throw new Error(
        `${key} must be absent, false, or 0 for real-cloud tests`,
      );
    }
  }

  for (const key of ["ALCHEMY_STAGE", "ALCHEMY_TEST_STAGE"]) {
    if (env[key] && env[key] !== env.ARC_CLOUD_STAGE) {
      throw new Error(`${key} must match ARC_CLOUD_STAGE`);
    }
  }

  return Schema.decodeUnknownSync(CloudSettings)({
    stage: env.ARC_CLOUD_STAGE,
    run: env.ARC_CLOUD_RUN,
    profile: env.ALCHEMY_PROFILE ?? "default",
  });
}

export const CloudResourceEvidence = Schema.Struct({
  stage: TestStage,
  workers: Schema.Array(Schema.NonEmptyString),
  namespaces: Schema.Array(Schema.NonEmptyString),
});

export function syntheticEnvironment(
  inherited: NodeJS.ProcessEnv,
  settings: CloudSettings,
): NodeJS.ProcessEnv {
  const env = {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) => !/^(TWITCH_|DISCORD_|ARC_|OPERATOR_)/.test(key),
      ),
    ),
    CI: inherited.CI ?? "false",
    ALCHEMY_PROFILE: settings.profile,
    ALCHEMY_TEST_STAGE: settings.stage,
    ARC_CLOUD_STAGE: settings.stage,
    ARC_CLOUD_RUN: settings.run,
    ARC_STAGE: settings.stage,
    APPLICATION_STAGE: settings.stage,
    ARC_ENVIRONMENT: "test",
    TWITCH_SENDER_KIND: "synthetic",
    TWITCH_SENDER_LOGIN: "fixture_sender",
    TWITCH_CHANNEL_LOGINS: "fixture_channel",
    TWITCH_CLIENT_ID: "fixture-twitch",
    DISCORD_APPLICATION_ID: "fixture-discord",
    TWITCH_CLIENT_SECRET: "fixture-secret",
    TWITCH_SIGNING_SECRET: "fixture-signing",
    DISCORD_BOT_TOKEN: "fixture-token",
    DISCORD_PUBLIC_KEY:
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    OPERATOR_SECRET: "fixture-operator",
  };

  cloudSettings(env);

  return env;
}
