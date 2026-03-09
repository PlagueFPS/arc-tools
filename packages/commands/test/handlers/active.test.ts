import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { activeHandler } from "../../src/handlers/active.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(activeHandler);

describe("activeHandler", () => {
  it.effect("returns no active events when none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(2000);
      const result = yield* run({
        events: [event({ startTime: 0, endTime: 1000 })],
      })("");
      assert.strictEqual(result, "No active events");
    }),
  );

  it.effect("returns single active event", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(500);
      const result = yield* run({
        events: [
          event({ name: "Event", map: "Map", startTime: 0, endTime: 1000 }),
        ],
      })("");
      assert.include(result, "Event on Map");
      assert.include(result, "ends in");
    }),
  );

  it.effect("returns multiple active events", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(500);
      const result = yield* run({
        events: [
          event({ name: "A", map: "M1", startTime: 0, endTime: 1000 }),
          event({ name: "B", map: "M2", startTime: 0, endTime: 1000 }),
        ],
      })("");
      assert.include(result, "A on M1");
      assert.include(result, "B on M2");
    }),
  );

  it.effect("inclusive end boundary - event at exact endTime is active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const result = yield* run({
        events: [
          event({ name: "Event", map: "Map", startTime: 0, endTime: 1000 }),
        ],
      })("");
      assert.include(result, "Event on Map");
    }),
  );
});
