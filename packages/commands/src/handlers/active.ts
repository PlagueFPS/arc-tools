import { fetchEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Clock, Effect } from "effect";
import { CommandError } from "../lib/command-error";
import { CommandLayer } from "../lib/layers";

export const activeHandler = Effect.fn("Command.activeHandler")(
  function* (_search: string) {
    const events = yield* fetchEvents();
    const now = yield* Clock.currentTimeMillis;
    const active = events.filter((e) => e.startTime <= now && now <= e.endTime);

    if (active.length === 0) {
      return yield* Effect.succeed("No active events");
    }

    const lines = active.map(
      (e) =>
        `${e.name} on ${e.map} (ends in ${formatMinutes(e.endTime - now)})`,
    );
    return yield* Effect.succeed(lines.join(", "));
  },
  (self) =>
    Effect.mapError(self, (cause) => new CommandError({ cause })).pipe(
      Effect.provide(CommandLayer),
    ),
);
