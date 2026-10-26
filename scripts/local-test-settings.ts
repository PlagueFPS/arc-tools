import { Schema } from "effect";

import { CloudSettings, syntheticEnvironment } from "./cloud-settings.js";

export const LocalTestSettings = Schema.Struct({
  ...CloudSettings.fields,
  profile: Schema.Literal("local-tests"),
  dev: Schema.Literal(true),
}).check(Schema.makeFilter((value) => value.stage.endsWith(`-${value.run}`)));

export const LocalTestResources = Schema.Struct({
  stage: CloudSettings.fields.stage,
  origins: Schema.Array(
    Schema.String.check(Schema.isPattern(/^http:\/\/localhost:\d+$/)),
  ),
});

export function localTestSettings(env: NodeJS.ProcessEnv) {
  if (env.ALCHEMY_TEST_DEV !== undefined)
    throw new Error(
      "Use the local infrastructure runner without ALCHEMY_TEST_DEV overrides",
    );

  for (const key of ["ALCHEMY_STAGE", "ALCHEMY_TEST_STAGE"]) {
    if (env[key] && env[key] !== env.ARC_CLOUD_STAGE)
      throw new Error(`${key} must match ARC_CLOUD_STAGE`);
  }

  return Schema.decodeUnknownSync(LocalTestSettings)({
    stage: env.ARC_CLOUD_STAGE,
    run: env.ARC_CLOUD_RUN,
    profile: "local-tests",
    dev: true,
  });
}

export function localTestEnvironment(
  inherited: NodeJS.ProcessEnv,
  settings: typeof LocalTestSettings.Type,
): NodeJS.ProcessEnv {
  const env = syntheticEnvironment(
    Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) =>
          !/^(ALCHEMY_|CLOUDFLARE_|CF_|GITHUB_TOKEN$|GH_TOKEN$)/.test(key),
      ),
    ),
    settings,
  );

  return {
    ...env,
    ARC_BOT_URL: "https://fixture.invalid",
    CI: "true",
    ALCHEMY_DEV: "true",
    ALCHEMY_TEST_DEV: undefined,
    ALCHEMY_TELEMETRY_DISABLED: "1",
  };
}
