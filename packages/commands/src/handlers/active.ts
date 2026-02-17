import { fetchEvents } from "@arctools/arc-data";
import { formatMinutes } from "@arctools/utils";
import { Effect } from "effect";
import { CommandLayer } from "../lib/layers";

export const activeHandler = (_search: string) =>
  Effect.gen(function* () {
    const events = yield* fetchEvents();
    const now = Date.now();
    const active = events.filter((e) => e.startTime <= now && now <= e.endTime);

    if (active.length === 0) {
      return yield* Effect.succeed("No active events");
    }

    const lines = active.map(
      (e) =>
        `${e.name} on ${e.map} (ends in ${formatMinutes(e.endTime - now)})`,
    );
    return yield* Effect.succeed(lines.join(", "));
  }).pipe(
    Effect.withLogSpan("active_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch event data")),
    Effect.provide(CommandLayer),
  );
