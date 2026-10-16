import { expect, test } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { cloudSettings } from "../../../scripts/cloud-settings.js";
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

const effects = Test.make({ providers: Layer.empty });
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
