import { describe, expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { eventHandler } from "../../src/handlers/event.js";
import { event } from "../fixtures.js";
import { runWithMock } from "../utils.js";

const run = runWithMock(eventHandler);

const { test } = Test.make({ providers: Layer.empty });

describe("eventHandler", () => {
  test(
    "returns hint for empty input",
    Effect.gen(function* () {
      const result = yield* run({})("");
      expect(result).toBe(
        "Please provide an event or map name (e.g. '!event Prospecting Probes')",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "returns no match when no events",
    Effect.gen(function* () {
      const result = yield* run({})("doesnotexist");
      expect(result).toBe(
        "[Warn] No event or map found matching: doesnotexist",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "active event shows ends in",
    Effect.gen(function* () {
      yield* TestClock.setTime(1500);
      const result = yield* run({
        events: [event({ startTime: 1000, endTime: 2000 })],
      })("prospecting");
      expect(result).toContain("is active now");
      expect(result).toContain("ends in");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "upcoming event shows starts in",
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const result = yield* run({
        events: [event({ startTime: 60_000, endTime: 120_000 })],
      })("prospecting");
      expect(result).toContain("starts in");
      expect(result).toContain("1m");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "queen alias rewrites to harvester",
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
      expect(result).toContain("Harvester");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  test(
    "no match reports normalized search",
    Effect.gen(function* () {
      const result = yield* run({
        events: [event()],
      })("nonexistent");
      expect(result).toBe("[Warn] No event or map found matching: nonexistent");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
