import { expect, test } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { cloudSettings } from "../../../scripts/cloud-settings.js";
import { botRequestObservation } from "../../../tests/cloud/bot-composition.js";
import { EnvironmentConfig, runtimeConfig } from "../src/config.js";
import { CommandInput, GuildId, tenantName } from "../src/contracts.js";

const stage = "test-foundation-0123456789ab";

const fixture = {
  stage,
  applicationStage: stage,
  kind: "test",
  senderKind: "synthetic",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel"],
  twitchClientId: "fixture-twitch",
  discordApplicationId: "fixture-discord",
} as const satisfies typeof EnvironmentConfig.Type;

const decode = Schema.decodeUnknownSync(EnvironmentConfig);

for (const stage of ["local-enrollment", "staging"] as const) {
  test(`dedicated bots can use their own real application in ${stage}`, () => {
    const bot = {
      ...fixture,
      kind: "bot",
      stage,
      applicationStage: stage,
      senderKind: "bot",
      senderLogin: "test_bot",
      channelLogins: ["test_channel"],
      twitchClientId: "independent-test-application",
      discordApplicationId: "independent-discord-application",
    } satisfies EnvironmentConfig;

    expect(decode(bot)).toEqual(bot);

    for (const overrides of [
      { applicationStage: "local-other" },
      { senderKind: "personal" },
      { senderKind: "synthetic" },
      { stage: fixture.stage, applicationStage: fixture.stage },
      { stage: "prod", applicationStage: "prod" },
      { channelLogins: [] },
    ])
      expect(() => decode({ ...bot, ...overrides })).toThrow();
  });
}

test("personal environments subscribe only to the sender channel", () => {
  const personal = {
    ...fixture,
    kind: "personal",
    stage: "staging",
    applicationStage: "staging",
    senderKind: "personal",
    senderLogin: "personal",
    channelLogins: ["personal"],
  };

  expect(decode(personal).channelLogins).toEqual(["personal"]);
  expect(() => decode({ ...personal, channelLogins: ["other"] })).toThrow();
  expect(() =>
    decode({ ...personal, channelLogins: ["personal", "other"] }),
  ).toThrow();
  expect(() => decode({ ...personal, stage: "prod" })).toThrow();
});

test("production requires a dedicated bot and a configured channel set", () => {
  const production = {
    ...fixture,
    stage: "prod",
    applicationStage: "prod",
    kind: "production",
    senderKind: "bot",
    channelLogins: ["channel_one", "channel_two"],
  };

  expect(decode(production).channelLogins).toEqual([
    "channel_one",
    "channel_two",
  ]);
  expect(() => decode({ ...production, senderKind: "personal" })).toThrow();
  expect(() => decode({ ...production, channelLogins: [] })).toThrow();
});

test("synthetic test identities cannot select live apps or stages", () => {
  expect(decode(fixture).stage).toBe(stage);

  for (const overrides of [
    { stage: "prod" },
    { applicationStage: "prod" },
    { stage: "staging" },
    { twitchClientId: "live-app" },
    { senderLogin: "personal" },
  ]) {
    expect(() => decode({ ...fixture, ...overrides })).toThrow();
  }
});

test("cloud settings reject local emulation, stage aliases and missing run identity", () => {
  const env = { ARC_CLOUD_STAGE: stage, ARC_CLOUD_RUN: "0123456789ab" };
  expect(cloudSettings(env).stage).toBe(stage);

  for (const overrides of [
    { ALCHEMY_DEV: "1" },
    { ALCHEMY_TEST_DEV: "yes" },
    { ALCHEMY_STAGE: "prod" },
    { ALCHEMY_TEST_STAGE: "staging" },
    { ARC_CLOUD_RUN: "ffffffffffff" },
    { ARC_CLOUD_STAGE: "prod" },
  ]) {
    expect(() => cloudSettings({ ...env, ...overrides })).toThrow();
  }
});

test("tenant partitions use verified transport IDs and command names come from the registry", () => {
  const guildId = Schema.decodeUnknownSync(GuildId)("1234");
  expect(tenantName({ transport: "discord", guildId })).toBe("discord:1234");
  expect(
    Schema.decodeUnknownSync(CommandInput)({
      command: "active",
      input: "",
      deadline: 1000,
    }).command,
  ).toBe("active");
  expect(() =>
    Schema.decodeUnknownSync(CommandInput)({
      command: "unknown",
      input: "",
      deadline: 1000,
    }),
  ).toThrow();
});

test("request observers are isolated and reject personal or production composition", () => {
  const stage = "test-tenant-12345678-0123456789ab";
  const synthetic = decode({ ...fixture, stage, applicationStage: stage });
  const first = botRequestObservation(synthetic);
  first.observer.lookup();
  first.observer.rpc();
  expect(first.headers()["x-arc-tenant-lookups"]).toBe("1");
  const next = botRequestObservation(synthetic);
  expect(next.headers()["x-arc-tenant-lookups"]).toBe("0");
  expect(next.headers()["x-arc-tenant-rpcs"]).toBe("0");

  for (const identity of [
    decode({
      ...fixture,
      kind: "personal",
      stage: "staging",
      applicationStage: "staging",
      senderKind: "personal",
      senderLogin: "personal",
      channelLogins: ["personal"],
    }),
    decode({
      ...fixture,
      kind: "production",
      stage: "prod",
      applicationStage: "prod",
      senderKind: "bot",
    }),
    decode(fixture),
  ]) {
    expect(() => botRequestObservation(identity)).toThrow();
  }
});

const effects = Test.make({ providers: Layer.empty });

for (const stage of ["local-enrollment", "staging"]) {
  effects.test(
    `runtime accepts the ${stage} bot profile without provider I/O`,
    Effect.gen(function* () {
      const config = yield* runtimeConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            ARC_STAGE: stage,
            APPLICATION_STAGE: stage,
            ARC_ENVIRONMENT: "bot",
            TWITCH_SENDER_KIND: "bot",
            TWITCH_SENDER_LOGIN: "development_bot",
            TWITCH_CHANNEL_LOGINS: "development_channel,other_channel",
            TWITCH_CLIENT_ID: "independent-test-application",
            DISCORD_APPLICATION_ID: "independent-discord-application",
            TWITCH_CLIENT_SECRET: "controlled-client-secret",
            TWITCH_SIGNING_SECRET: "controlled-signing-secret",
            DISCORD_BOT_TOKEN: "controlled-discord-token",
            DISCORD_PUBLIC_KEY: "a".repeat(64),
            OPERATOR_SECRET: "controlled-operator-secret",
          }),
        ),
      );

      expect(config.identity).toMatchObject({
        stage,
        applicationStage: stage,
        kind: "bot",
        senderKind: "bot",
        twitchClientId: "independent-test-application",
        channelLogins: ["development_channel", "other_channel"],
      });
    }),
  );
}

effects.test(
  "runtime configuration resolves declared bindings without provider I/O",
  Effect.gen(function* () {
    const config = yield* runtimeConfig.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ARC_STAGE: stage,
          APPLICATION_STAGE: stage,
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
        }),
      ),
    );

    expect(config.identity).toEqual(fixture);
  }),
);
