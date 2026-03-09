import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { eventHandler } from "../../src/handlers/event.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(eventHandler);

describe("eventHandler", () => {
  it.effect("returns hint for empty input", () =>
    Effect.gen(function* () {
      const result = yield* run({})("");
      assert.strictEqual(
        result,
        "Please provide an event or map name (e.g. '!event Prospecting Probes')",
      );
    }),
  );

  it.effect("returns no match when no events", () =>
    Effect.gen(function* () {
      const result = yield* run({})("doesnotexist");
      assert.strictEqual(
        result,
        "[Warn] No event or map found matching: doesnotexist",
      );
    }),
  );

  it.effect("active event shows ends in", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1500);
      const result = yield* run({
        events: [event({ startTime: 1000, endTime: 2000 })],
      })("prospecting");
      assert.include(result, "is active now");
      assert.include(result, "ends in");
    }),
  );

  it.effect("upcoming event shows starts in", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [event({ startTime: 60_000, endTime: 120_000 })],
      })("prospecting");
      assert.include(result, "starts in");
      assert.include(result, "1m");
    }),
  );

  it.effect("queen alias rewrites to harvester", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [
          event({
            name: "Harvester",
            map: "Map",
            startTime: 1000,
            endTime: 2000,
          }),
        ],
      })("queen");
      assert.include(result, "Harvester");
    }),
  );

  it.effect("no match reports normalized search", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [event()],
      })("nonexistent");
      assert.strictEqual(
        result,
        "[Warn] No event or map found matching: nonexistent",
      );
    }),
  );
});
