import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { selectEvent } from "../src/events.js";
import type { Event } from "../src/schema.js";

const event = (overrides: Partial<Event> = {}) => ({
  name: "Prospecting Probes",
  map: "Bastion",
  startTime: 1000,
  endTime: 2000,
  ...overrides,
});

describe("selectEvent", () => {
  it.effect("returns none when no matches", () =>
    Effect.gen(function* () {
      const result = yield* selectEvent([event()], "nonexistent");
      assert.isTrue(Option.isNone(result));
    }),
  );

  it.effect("prefers active event over upcoming", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1500);
      const result = yield* selectEvent(
        [
          event({ name: "A", startTime: 0, endTime: 1000 }),
          event({ name: "A", startTime: 2000, endTime: 3000 }),
          event({ name: "A", startTime: 1000, endTime: 2000 }),
        ],
        "a",
      );
      const match = Option.getOrThrow(result);
      assert.strictEqual(match.startTime, 1000);
    }),
  );

  it.effect("returns nearest upcoming when none active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* selectEvent(
        [
          event({ name: "E", startTime: 5000, endTime: 6000 }),
          event({ name: "E", startTime: 1000, endTime: 2000 }),
          event({ name: "E", startTime: 3000, endTime: 4000 }),
        ],
        "e",
      );
      const match = Option.getOrThrow(result);
      assert.strictEqual(match.startTime, 1000);
    }),
  );

  it.effect("matches by name only (not map)", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* selectEvent(
        [
          event({
            name: "Harvester",
            map: "Map",
            startTime: 1000,
            endTime: 2000,
          }),
        ],
        "harvester",
      );
      const match = Option.getOrThrow(result);
      assert.strictEqual(match.name, "Harvester");
    }),
  );

  it.effect("exact boundary - event at startTime is active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const result = yield* selectEvent(
        [event({ startTime: 1000, endTime: 2000 })],
        "prospecting",
      );
      assert.isTrue(Option.isSome(result));
    }),
  );

  it.effect(
    "exact boundary - event at endTime hands off to next same event",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(2000);
        const result = yield* selectEvent(
          [
            event({ name: "A", map: "Dam", startTime: 1000, endTime: 2000 }),
            event({
              name: "A",
              map: "Spaceport",
              startTime: 2000,
              endTime: 3000,
            }),
          ],
          "a",
        );
        const match = Option.getOrThrow(result);
        assert.strictEqual(match.startTime, 2000);
      }),
  );
});
