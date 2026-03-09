import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { decodeTokenData } from "../src/services/auth.js";

describe("decodeTokenData", () => {
  it.effect("decodes valid snake_case DB row", () =>
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: "refresh",
        expires_in: 3600,
        obtainment_timestamp: 1000,
        scope: JSON.stringify(["chat"]),
      };
      const result = yield* decodeTokenData(row);
      assert.strictEqual(result.accessToken, "token");
      assert.strictEqual(result.refreshToken, "refresh");
      assert.strictEqual(result.expiresIn, 3600);
      assert.strictEqual(result.obtainmentTimestamp, 1000);
      assert.deepEqual(result.scope, ["chat"]);
    }),
  );

  it.effect("decodes with null refresh_token and expires_in", () =>
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: "[]",
      };
      const result = yield* decodeTokenData(row);
      assert.strictEqual(result.accessToken, "token");
      assert.isNull(result.refreshToken);
      assert.isNull(result.expiresIn);
    }),
  );

  it.effect("fails when scope is invalid JSON", () =>
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: "not-valid-json",
      };
      const exit = yield* Effect.exit(decodeTokenData(row));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("fails when scope is not a JSON array", () =>
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: '"string"',
      };
      const exit = yield* Effect.exit(decodeTokenData(row));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("fails when required fields missing", () =>
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: "[]",
      };
      const exit = yield* Effect.exit(
        decodeTokenData({ ...row, access_token: undefined }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
