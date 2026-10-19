import { describe, expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { activeHandler } from "../../src/handlers/active.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(activeHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("activeHandler", () => {
  test(
    "returns no active events when none",
    Effect.gen(function* () {
      yield* TestClock.setTime(2000);
      const result = yield* run({
        events: [event({ startTime: 0, endTime: 1000 })],
      })("");
      expect(result).toBe("No active events");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "returns single active event",
    Effect.gen(function* () {
      yield* TestClock.setTime(500);
      const result = yield* run({
        events: [
          event({ name: "Event", map: "Map", startTime: 0, endTime: 1000 }),
        ],
      })("");
      expect(result).toContain("Event on Map");
      expect(result).toContain("ends in");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "returns multiple active events",
    Effect.gen(function* () {
      yield* TestClock.setTime(500);
      const result = yield* run({
        events: [
          event({ name: "A", map: "M1", startTime: 0, endTime: 1000 }),
          event({ name: "B", map: "M2", startTime: 0, endTime: 1000 }),
        ],
      })("");
      expect(result).toContain("A on M1");
      expect(result).toContain("B on M2");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "inclusive end boundary - event at exact endTime is active",
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const result = yield* run({
        events: [
          event({ name: "Event", map: "Map", startTime: 0, endTime: 1000 }),
        ],
      })("");
      expect(result).toContain("Event on Map");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
