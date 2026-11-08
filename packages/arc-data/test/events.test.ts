/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { describe, expect } from "bun:test";

import * as Test from "@alchemy.run/test/Bun";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { selectEvent } from "../src/events.js";
import { Event } from "../src/schema.js";

const event = (overrides: Partial<Event> = {}) =>
  new Event({
    name: "Prospecting Probes",
    map: "Bastion",
    startTime: 1000,
    endTime: 2000,
    ...overrides,
  });

const { test } = Test.make({ providers: Layer.empty });

describe("selectEvent", () => {
  test(
    "returns none when no matches",
    Effect.gen(function* () {
      const result = yield* selectEvent([event()], "nonexistent");
      expect(Option.isNone(result)).toBeTrue();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "prefers active event over upcoming",
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
      expect(match.startTime).toBe(1000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "returns nearest upcoming when none active",
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
      expect(match.startTime).toBe(1000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "keeps source order when nearest upcoming events share a start time",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);

      const later = event({ name: "Later", startTime: 5000, endTime: 6000 });
      const first = event({ name: "First", startTime: 1000, endTime: 2000 });
      const second = event({ name: "Second", startTime: 1000, endTime: 2000 });
      const events = [later, first, second];

      const result = yield* selectEvent(events, "bastion");

      expect(Option.getOrThrow(result)).toBe(first);
      expect(events).toEqual([later, first, second]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "matches by event name",
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
      expect(match.name).toBe("Harvester");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "accepts suggested map names and selects active then nearest upcoming",
    Effect.gen(function* () {
      yield* TestClock.setTime(1500);

      const events = [
        event({
          name: "Later",
          map: "Spaceport",
          startTime: 4000,
          endTime: 5000,
        }),
        event({
          name: "Next",
          map: "Spaceport",
          startTime: 2000,
          endTime: 3000,
        }),
        event({
          name: "Active",
          map: "Spaceport",
          startTime: 1000,
          endTime: 2000,
        }),
      ];

      expect(
        Option.getOrThrow(yield* selectEvent(events, "Spaceport")).name,
      ).toBe("Active");
      yield* TestClock.setTime(2000);

      expect(
        Option.getOrThrow(yield* selectEvent(events, "Spaceport")).name,
      ).toBe("Next");
      expect(
        Option.isNone(yield* selectEvent(events, "unknown map")),
      ).toBeTrue();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "exact boundary - event at startTime is active",
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);

      const result = yield* selectEvent(
        [event({ startTime: 1000, endTime: 2000 })],
        "prospecting",
      );

      expect(Option.isSome(result)).toBeTrue();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "exact boundary - event at endTime hands off to next same event",
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
      expect(match.startTime).toBe(2000);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
