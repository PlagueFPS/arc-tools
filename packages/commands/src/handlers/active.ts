import { getEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Clock, Effect } from "effect";
import { CommandError } from "../lib/command-error";

export const activeHandler = Effect.fn("Command.activeHandler")(
  function* () {
    const events = yield* getEvents();
    const now = yield* Clock.currentTimeMillis;
    const active = events.filter((e) => e.startTime <= now && now <= e.endTime);

    if (active.length === 0) {
      return yield* Effect.succeed("No active events");
    }

    const response = active
      .map(
        (e) =>
          `${e.name} on ${e.map} (ends in ${formatMinutes(e.endTime - now)})`,
      )
      .join(", ");
    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
