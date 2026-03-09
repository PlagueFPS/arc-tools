import { createMockHttpClientLayer } from "@arctools/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { resolveItem } from "../../src/handlers/utils.js";

const runWithMock =
  (mock: Parameters<typeof createMockHttpClientLayer>[0]) =>
  (
    search: string,
    params: { includeComponents?: boolean; minimal?: boolean },
  ) =>
    resolveItem(search, params).pipe(
      Effect.provide(createMockHttpClientLayer(mock)),
    );

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "power-cell",
  name: "Power Cell",
  value: 50,
  workbench: null,
  loot_area: null,
  components: null,
  recycle_components: null,
  recycle_from: null,
  dropped_by: null,
  ...overrides,
});

describe("resolveItem", () => {
  it.effect("slug lookup succeeds without fallback", () =>
    Effect.gen(function* () {
      const result = yield* runWithMock({
        items: [item({ id: "power-cell", name: "Power Cell" })],
      })("power-cell", { minimal: true });
      const resolved = Option.getOrThrow(result);
      assert.strictEqual(resolved.id, "power-cell");
    }),
  );

  it.effect("slug miss and normalized search fallback succeeds", () =>
    Effect.gen(function* () {
      const result = yield* runWithMock({
        items: [item({ id: "power-cell", name: "Power Cell" })],
      })("cell", { minimal: true });
      const resolved = Option.getOrThrow(result);
      assert.strictEqual(resolved.name, "Power Cell");
    }),
  );

  it.effect("both lookups miss returns none", () =>
    Effect.gen(function* () {
      const result = yield* runWithMock({})("nonexistent", { minimal: true });
      assert.isTrue(Option.isNone(result));
    }),
  );

  it.effect("forwards includeComponents param", () =>
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
      assert.isTrue(Option.isSome(resolved.components));
    }),
  );
});
