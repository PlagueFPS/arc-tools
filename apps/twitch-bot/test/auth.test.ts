import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Exit, Layer } from "effect";
import { decodeTokenData } from "../src/services/auth.js";

const { test } = Test.make({ providers: Layer.empty });

describe("decodeTokenData", () => {
  test(
    "decodes valid snake_case DB row",
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: "refresh",
        expires_in: 3600,
        obtainment_timestamp: 1000,
        scope: JSON.stringify(["chat"]),
      };
      const result = yield* decodeTokenData(row);
      expect(result.accessToken).toBe("token");
      expect(result.refreshToken).toBe("refresh");
      expect(result.expiresIn).toBe(3600);
      expect(result.obtainmentTimestamp).toBe(1000);
      expect(result.scope).toEqual(["chat"]);
    }),
  );

  test(
    "decodes with null refresh_token and expires_in",
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: "[]",
      };
      const result = yield* decodeTokenData(row);
      expect(result.accessToken).toBe("token");
      expect(result.refreshToken).toBeNull();
      expect(result.expiresIn).toBeNull();
    }),
  );

  test(
    "fails when scope is invalid JSON",
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: "not-valid-json",
      };
      const exit = yield* Effect.exit(decodeTokenData(row));
      expect(Exit.isFailure(exit)).toBeTrue();
    }),
  );

  test(
    "fails when scope is not a JSON array",
    Effect.gen(function* () {
      const row = {
        access_token: "token",
        refresh_token: null,
        expires_in: null,
        obtainment_timestamp: 1000,
        scope: '"string"',
      };
      const exit = yield* Effect.exit(decodeTokenData(row));
      expect(Exit.isFailure(exit)).toBeTrue();
    }),
  );

  test(
    "fails when required fields missing",
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
      expect(Exit.isFailure(exit)).toBeTrue();
    }),
  );
});
