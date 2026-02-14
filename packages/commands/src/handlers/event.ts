import { fetchEvents, selectEvent } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Effect } from "effect";
import { CommandLayer } from "../lib/layers";

export const eventHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an event or map name (e.g. '!event Prospecting Probes')",
      );
    }

    const events = yield* fetchEvents();
    const match = selectEvent(events, search);
    if (!match) {
      return yield* Effect.succeed(
        `[Warn] No event or map found matching: ${search}`,
      );
    }

    const now = Date.now();
    const base = `${match.name} on ${match.map}`;

    if (match.startTime <= now && now <= match.endTime) {
      const remaining = match.endTime - now;
      return yield* Effect.succeed(
        `${base} is active now (ends in ${formatMinutes(remaining)})`,
      );
    }

    const startsIn = match.startTime - now;
    return yield* Effect.succeed(
      `${base} starts in ${formatMinutes(startsIn)}`,
    );
  }).pipe(
    Effect.withLogSpan("event_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch event data")),
    Effect.provide(CommandLayer),
  );
