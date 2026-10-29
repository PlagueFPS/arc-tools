import { getEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { pipe, Clock, Effect, Array as Arr } from "effect";

import { CommandError } from "../lib/command-error.js";

export const activeHandler = Effect.fn("Command.activeHandler")(
  function* (_input: string) {
    const events = yield* getEvents();
    const now = yield* Clock.currentTimeMillis;

    const active = Arr.filter(
      events,
      (e) => !!(e.startTime <= now && now <= e.endTime),
    );

    if (active.length === 0) {
      return yield* Effect.succeed("No active events");
    }

    const response = pipe(
      active,
      Arr.map(
        (e) =>
          `${e.name} on ${e.map} (ends in ${formatMinutes(e.endTime - now)})`,
      ),
      Arr.join(", "),
    );

    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
