import { describe, expect } from "bun:test";

import { DataUnavailable } from "@arctools/arc-data";
import { makeFixture } from "@arctools/arc-data/testing";
import * as Test from "alchemy/Test/Bun";
import {
  Result,
  Predicate,
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
} from "effect";
import { TestClock } from "effect/testing";

import { executeCommand } from "../src/execute.js";
import { CommandError } from "../src/lib/command-error.js";

const { test: effectTest } = Test.make({ providers: Layer.empty });

const test = <E>(name: string, effect: Effect.Effect<void, E>) =>
  effectTest(name, effect.pipe(Effect.provide(TestClock.layer())));

const day = 86_400_000;

const execute = (
  command: Parameters<typeof executeCommand>[0]["command"],
  input: string,
  deadline = day * 8,
) => executeCommand({ command, input, deadline });

describe("cached command execution", () => {
  for (const stale of [false, true]) {
    for (const elapsed of [19, 20, 100]) {
      test(
        `synchronous completion at ${elapsed}ms with stale=${stale} respects the absolute 20ms deadline`,
        Effect.gen(function* () {
          const fixture = yield* makeFixture();

          if (stale) {
            fixture.body({ data: [] });
            yield* fixture.data.items({ id: "missing", minimal: true });
            yield* TestClock.setTime(day);
          }

          const startedAt = stale ? day : 0;
          let now = startedAt;
          const scheduledClock = yield* Clock.Clock;

          const clock: Clock.Clock = {
            currentTimeMillis: Effect.sync(() => now),
            currentTimeMillisUnsafe: () => now,
            currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
            currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
            monotonicTimeNanos: scheduledClock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () =>
              scheduledClock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => scheduledClock.sleep(duration),
          };

          fixture.respond((url) =>
            url.searchParams.get("id") === "missing"
              ? Effect.succeed(new Response("offline", { status: 503 }))
              : Effect.sync(() => {
                  now = startedAt + elapsed;

                  return Response.json({
                    data: [{ id: "sensors", name: "Sensors", value: 10 }],
                  });
                }),
          );

          const result = yield* execute(
            "sell",
            stale ? "missing" : "sensors",
            startedAt + 20,
          ).pipe(
            Effect.provide(fixture.layer),
            Effect.provideService(Clock.Clock, clock),
            Effect.result,
          );

          if (elapsed < 20) {
            expect(result).toMatchObject(
              Result.succeed({
                text: stale
                  ? "Sensors can be sold for 10 coins each [Using cached data]"
                  : "Sensors can be sold for 10 coins each",
                stale,
              }),
            );
          } else {
            expect(result).toMatchObject(
              Result.fail(
                new CommandError({
                  cause: new DataUnavailable({
                    resource: "command",
                    reason: "deadline",
                  }),
                  stale,
                }),
              ),
            );

            if (Predicate.isTagged(result, "Failure")) {
              expect(result.failure.message).toBe(
                stale
                  ? "Game data is temporarily unavailable. Please try again shortly. [Using cached data]"
                  : "Game data is temporarily unavailable. Please try again shortly.",
              );
            }
          }
        }),
      );
    }
  }

  test(
    "each concurrent execution owns its stale indication, including stale lookup misses",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.respond((url) =>
        Effect.succeed(
          Response.json({
            data:
              url.searchParams.get("id") === "missing"
                ? []
                : [{ id: "sensors", name: "Sensors", value: 10 }],
          }),
        ),
      );
      yield* fixture.data.items({ id: "sensors", minimal: true });
      yield* fixture.data.items({ id: "missing", minimal: true });
      yield* TestClock.setTime(day);
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      fixture.respond((url) =>
        url.searchParams.get("id") === "fresh"
          ? Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);

              return Response.json({
                data: [{ id: "fresh", name: "Fresh", value: 20 }],
              });
            })
          : url.searchParams.has("search")
            ? Effect.succeed(
                Response.json({
                  data: [{ id: "resolved", name: "Resolved", value: 30 }],
                }),
              )
            : Effect.succeed(new Response("offline", { status: 503 })),
      );

      const fresh = yield* execute("sell", "fresh").pipe(
        Effect.provide(fixture.layer),
        Effect.forkChild,
      );

      yield* Deferred.await(started);

      const stale = yield* execute("sell", "sensors").pipe(
        Effect.provide(fixture.layer),
      );

      expect(stale).toEqual({
        text: "Sensors can be sold for 10 coins each [Using cached data]",
        stale: true,
      });

      const staleMiss = yield* execute("sell", "missing").pipe(
        Effect.provide(fixture.layer),
      );

      expect(staleMiss).toEqual({
        text: "Resolved can be sold for 30 coins each [Using cached data]",
        stale: true,
      });
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fresh)).toEqual({
        text: "Fresh can be sold for 20 coins each",
        stale: false,
      });
      expect(
        yield* execute("sell", "fresh").pipe(Effect.provide(fixture.layer)),
      ).toEqual({ text: "Fresh can be sold for 20 coins each", stale: false });
    }),
  );

  test(
    "events recalculate the clock, queen alias, name-only lookup, boundaries and two-hour window on cached schedules",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({
        data: [
          { name: "Harvester", map: "Dam", startTime: 0, endTime: 60_000 },
          {
            name: "Harvester",
            map: "Spaceport",
            startTime: 60_000,
            endTime: 180_000,
          },
          {
            name: "Window",
            map: "Bastion",
            startTime: 7_200_000,
            endTime: 8_000_000,
          },
        ],
      });

      const run = (command: Parameters<typeof execute>[0], input = "") =>
        execute(command, input).pipe(Effect.provide(fixture.layer));

      expect((yield* run("event", "queen")).text).toBe(
        "Harvester on Dam is active now (ends in 1m)",
      );
      yield* TestClock.setTime(59_000);
      expect((yield* run("event", "queen")).text).toBe(
        "Harvester on Dam is active now (ends in 0m)",
      );
      expect((yield* run("event", "Dam")).text).toBe(
        "[Warn] No event or map found matching: dam",
      );
      expect((yield* run("upcoming")).text).toContain("Window on Bastion");
      expect(fixture.calls).toHaveLength(1);
      yield* TestClock.setTime(60_000);
      expect((yield* run("active")).text).toBe(
        "Harvester on Dam (ends in 0m), Harvester on Spaceport (ends in 2m)",
      );
      expect((yield* run("event", "queen")).text).toBe(
        "Harvester on Spaceport is active now (ends in 2m)",
      );
      expect(fixture.calls).toHaveLength(2);
    }),
  );

  test(
    "expired schedule errors and command deadlines fail without rendering cached answers",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({ data: [] });
      expect(
        yield* execute("active", "").pipe(Effect.provide(fixture.layer)),
      ).toEqual({ text: "No active events", stale: false });
      yield* TestClock.setTime(60_000);
      fixture.body({}, 503);

      const failed = yield* execute("active", "").pipe(
        Effect.provide(fixture.layer),
        Effect.result,
      );

      expect(failed._tag).toBe("Failure");

      if (Predicate.isTagged(failed, "Failure"))
        expect(failed.failure.message).toContain("temporarily unavailable");
      expect(
        (yield* execute("active", "", 60_000).pipe(
          Effect.provide(fixture.layer),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(fixture.calls).toHaveLength(2);
    }),
  );
  test(
    "all ten commands keep their exact outputs when their data comes from the cache",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.respond((url) =>
        Effect.succeed(
          Response.json({
            data: url.pathname.endsWith("/traders")
              ? {
                  Apollo: [],
                  Celeste: [],
                  Lance: [],
                  Shani: [
                    { id: "sensors", name: "Sensors", trader_price: 100 },
                  ],
                  TianWen: [],
                }
              : url.pathname.endsWith("/arcs")
                ? [
                    {
                      id: "bastion",
                      name: "Bastion",
                      loot: [{ item: { id: "sensors", name: "Sensors" } }],
                    },
                  ]
                : url.pathname.endsWith("/events-schedule")
                  ? [
                      {
                        name: "Harvester",
                        map: "Dam",
                        startTime: 0,
                        endTime: 120_000,
                      },
                      {
                        name: "Harvester",
                        map: "Spaceport",
                        startTime: 120_000,
                        endTime: 240_000,
                      },
                    ]
                  : [
                      {
                        id: "sensors",
                        name: "Sensors",
                        value: 10,
                        loot_area: "Industrial",
                        recycle_components: [],
                        recycle_from: [],
                      },
                    ],
          }),
        ),
      );

      const cases = [
        ["buy", "sensors", "Sensors can be purchased from Shani for 100 cred."],
        ["loot", "bastion", "Bastions drop the following items: Sensors"],
        ["craft", "sensors", "Sensors cannot be crafted."],
        ["find", "sensors", "Sensors can be found in Industrial areas."],
        ["sell", "sensors", "Sensors can be sold for 10 coins each"],
        ["recycle", "sensors", "No items granted for recycling Sensors"],
        ["recycleto", "sensors", "No items recycle to Sensors"],
        ["event", "queen", "Harvester on Dam is active now (ends in 2m)"],
        ["active", "", "Harvester on Dam (ends in 2m)"],
        ["upcoming", "", "Harvester on Spaceport (starts in 2m)"],
      ] as const;

      for (const [command, input, text] of cases)
        expect(
          yield* execute(command, input).pipe(Effect.provide(fixture.layer)),
        ).toEqual({ text, stale: false });
      expect(fixture.calls).toHaveLength(5);

      for (const [command, input, text] of cases)
        expect(
          yield* execute(command, input).pipe(Effect.provide(fixture.layer)),
        ).toEqual({ text, stale: false });
      expect(fixture.calls).toHaveLength(5);
    }),
  );
  test(
    "a failed search retains the stale indication from its consumed cached ID miss",
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.body({ data: [] });
      yield* fixture.data.items({ id: "missing", minimal: true });
      yield* TestClock.setTime(day);
      fixture.body({}, 503);

      const result = yield* execute("sell", "missing").pipe(
        Effect.provide(fixture.layer),
        Effect.result,
      );

      expect(result._tag).toBe("Failure");

      if (Predicate.isTagged(result, "Failure"))
        expect(result.failure.message).toBe(
          "Game data is temporarily unavailable. Please try again shortly. [Using cached data]",
        );
    }),
  );
});
