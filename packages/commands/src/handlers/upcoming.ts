import { fetchEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Duration, Effect } from "effect";
import { CommandLayer } from "../lib/layers";

export const upcomingHandler = (_search: string) =>
  Effect.gen(function* () {
    const events = yield* fetchEvents();
    const now = Date.now();
    const threeHoursFromNow = now + Duration.toMillis("2 hours");
    const upcoming = events
      .filter((e) => e.startTime > now && e.startTime <= threeHoursFromNow)
      .sort((a, b) => a.startTime - b.startTime);

    if (upcoming.length === 0) {
      return yield* Effect.succeed("No upcoming events");
    }

    const lines = upcoming.map(
      (e) =>
        `${e.name} on ${e.map} (starts in ${formatMinutes(e.startTime - now)})`,
    );
    return yield* Effect.succeed(lines.join(", "));
  }).pipe(
    Effect.withLogSpan("upcoming_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch event data")),
    Effect.provide(CommandLayer),
  );
