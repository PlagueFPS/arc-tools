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
