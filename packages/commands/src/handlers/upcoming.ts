import { getEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Clock, Duration, Effect, Array as Arr } from "effect";

import { CommandError } from "../lib/command-error.js";

export const upcomingHandler = Effect.fn("Command.upcomingHandler")(
  function* (_input: string) {
    const events = yield* getEvents();
    const now = yield* Clock.currentTimeMillis;
    const twoHoursFromNow = now + Duration.hours(2).pipe(Duration.toMillis);

    const upcoming = Arr.filter(
      events,
      (e) => !!(e.startTime > now && e.startTime <= twoHoursFromNow),
    ).sort((a, b) => a.startTime - b.startTime);

    if (upcoming.length === 0) {
      return yield* Effect.succeed("No upcoming events");
    }

    const response = Arr.join(
      Arr.map(
        upcoming,
        (e) =>
          `${e.name} on ${e.map} (starts in ${formatMinutes(e.startTime - now)})`,
      ),
      ", ",
    );

    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
