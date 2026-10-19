import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { upcomingHandler } from "../../src/handlers/upcoming.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(upcomingHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("upcomingHandler", () => {
  test(
    "returns no upcoming when none",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({ events: [] })("");
      expect(result).toBe("No upcoming events");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "returns single upcoming event",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [event({ name: "Event", map: "Map", startTime: 60_000 })],
      })("");
      expect(result).toContain("Event on Map");
      expect(result).toContain("starts in");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "sorts multiple upcoming by startTime",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [
          event({
            name: "Later",
            map: "M2",
            startTime: 120_000,
            endTime: 180_000,
          }),
          event({
            name: "Earlier",
            map: "M1",
            startTime: 60_000,
            endTime: 120_000,
          }),
        ],
      })("");
      const idxEarlier = result.indexOf("Earlier");
      const idxLater = result.indexOf("Later");
      expect(idxEarlier >= 0).toBeTrue();
      expect(idxLater >= 0).toBeTrue();
      expect(idxEarlier < idxLater).toBeTrue();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "excludes events starting at or before now",
    Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const result = yield* run({
        events: [
          event({ startTime: 60_000, endTime: 120_000 }),
          event({ startTime: 59_999, endTime: 120_000 }),
        ],
      })("");
      expect(result).toBe("No upcoming events");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "excludes events beyond 2h window",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [
          event({
            startTime: 7200_001,
            endTime: 7300_000,
          }),
        ],
      })("");
      expect(result).toBe("No upcoming events");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "includes events exactly 2h away",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [
          event({
            name: "Harvester",
            map: "Dam",
            startTime: 7200_000,
            endTime: 7300_000,
          }),
        ],
      })("");
      expect(result).toContain("Harvester on Dam");
      expect(result).toContain("starts in 2h");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
