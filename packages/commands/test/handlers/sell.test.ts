/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { describe, expect } from "bun:test";

import { makeFixture } from "@arctools/arc-data/testing";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";

import { sellHandler } from "../../src/handlers/sell.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(sellHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("sellHandler", () => {
  for (const search of ["Bastion Cell", "bAsTiOn CeLl", "bastion-cell"]) {
    test(
      `resolves ${search} to the Bastion Cell API item`,
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.respond((url) =>
          Effect.succeed(
            Response.json({
              data:
                url.searchParams.get("id") === "bastion-part" ||
                url.searchParams.get("search") === "bastion cell"
                  ? [{ id: "bastion-part", name: "Bastion Cell", value: 3000 }]
                  : [],
            }),
          ),
        );

        const result = yield* sellHandler(search).pipe(
          Effect.provide(fixture.layer),
        );

        expect(result).toBe("Bastion Cell can be sold for 3000 coins each");
      }),
    );
  }

  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe("Please provide an item (e.g. '!sell sensors')");
    }),
  );

  test(
    "returns no such item when unresolved",
    Effect.gen(function* () {
      const result = yield* run({})("nonexistent");
      expect(result).toBe("[Warn] No such item: nonexistent");
    }),
  );

  test(
    "returns sell value on success",
    Effect.gen(function* () {
      const result = yield* run({
        items: [
          {
            id: "sensors",
            name: "Sensors",
            value: 25,
            workbench: null,
            loot_area: null,
            components: null,
            recycle_components: null,
            recycle_from: null,
            dropped_by: null,
          },
        ],
      })("sensors");

      expect(result).toBe("Sensors can be sold for 25 coins each");
    }),
  );
});
