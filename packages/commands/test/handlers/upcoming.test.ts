import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { upcomingHandler } from "../../src/handlers/upcoming.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(upcomingHandler);

describe("upcomingHandler", () => {
  it.effect("returns no upcoming when none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({ events: [] })("");
      assert.strictEqual(result, "No upcoming events");
    }),
  );

  it.effect("returns single upcoming event", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [event({ name: "Event", map: "Map", startTime: 60_000 })],
      })("");
      assert.include(result, "Event on Map");
      assert.include(result, "starts in");
    }),
  );

  it.effect("sorts multiple upcoming by startTime", () =>
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
      assert.isTrue(
        idxEarlier >= 0,
        "Earlier should be present in the response",
      );
      assert.isTrue(idxLater >= 0, "Later should be present in the response");
      assert.isTrue(idxEarlier < idxLater);
    }),
  );

  it.effect("excludes events starting at or before now", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const result = yield* run({
        events: [event({ startTime: 60_000, endTime: 120_000 })],
      })("");
      assert.strictEqual(result, "No upcoming events");
    }),
  );

  it.effect("excludes events beyond 2h window", () =>
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
      assert.strictEqual(result, "No upcoming events");
    }),
  );

  it.effect("includes events exactly 2h away", () =>
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
      assert.include(result, "Harvester on Dam");
      assert.include(result, "starts in 2h");
    }),
  );
});
