/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { describe, expect } from "bun:test";

import { createMockHttpClientLayer } from "@arctools/testing";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Option } from "effect";

import { resolveItem } from "../../src/handlers/utils.js";
import { item } from "../fixtures.js";

const runWithMock =
  (mock: Parameters<typeof createMockHttpClientLayer>[0]) =>
  (
    search: string,
    params: { includeComponents?: boolean; minimal?: boolean },
  ) =>
    resolveItem(search, params).pipe(
      Effect.provide(createMockHttpClientLayer(mock)),
    );

const { test } = Test.make({ providers: Layer.empty });

describe("resolveItem", () => {
  test(
    "slug lookup succeeds without fallback",
    Effect.gen(function* () {
      const result = yield* runWithMock({
        items: [item({ id: "power-cell", name: "Power Cell" })],
      })("power-cell", { minimal: true });

      const resolved = Option.getOrThrow(result);
      expect(resolved.id).toBe("power-cell");
    }),
  );

  test(
    "slug miss and normalized search fallback succeeds",
    Effect.gen(function* () {
      const result = yield* runWithMock({
        items: [item({ id: "power-cell", name: "Power Cell" })],
      })("cell", { minimal: true });

      const resolved = Option.getOrThrow(result);
      expect(resolved.name).toBe("Power Cell");
    }),
  );

  test(
    "both lookups miss returns none",
    Effect.gen(function* () {
      const result = yield* runWithMock({})("nonexistent", { minimal: true });
      expect(Option.isNone(result)).toBeTrue();
    }),
  );

  test(
    "forwards includeComponents param",
    Effect.gen(function* () {
      const result = yield* runWithMock({
        items: [
          item({
            id: "x",
            name: "X",
            components: [{ quantity: 1, component: { id: "c", name: "C" } }],
          }),
        ],
      })("x", { includeComponents: true });

      const resolved = Option.getOrThrow(result);
      expect(Option.isSome(resolved.components)).toBeTrue();
    }),
  );
});
