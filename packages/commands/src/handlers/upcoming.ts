import { fetchEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Clock, Duration, Effect } from "effect";
import { CommandError } from "../lib/command-error";

export const upcomingHandler = Effect.fn("Command.upcomingHandler")(
  function* () {
    const events = yield* fetchEvents();
    const now = yield* Clock.currentTimeMillis;
    const twoHoursFromNow = now + Duration.hours(2).pipe(Duration.toMillis);
    const upcoming = events
      .filter((e) => e.startTime > now && e.startTime <= twoHoursFromNow)
      .sort((a, b) => a.startTime - b.startTime);

    if (upcoming.length === 0) {
      return yield* Effect.succeed("No upcoming events");
    }

    const lines = upcoming.map(
      (e) =>
        `${e.name} on ${e.map} (starts in ${formatMinutes(e.startTime - now)})`,
    );
    return yield* Effect.succeed(lines.join(", "));
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
