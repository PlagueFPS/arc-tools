import { fetchEvents, selectEvent } from "@arctools/arc-data";
import { formatMinutes, normalize } from "@arctools/utils";
import { Effect } from "effect";
import { CommandError } from "../lib/command-error";
import { CommandLayer } from "../lib/layers";

export const eventHandler = Effect.fn("Command.eventHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an event or map name (e.g. '!event Prospecting Probes')",
      );
    }

    let normalizedSearch = normalize(search.trim());
    if (normalizedSearch.includes("queen")) {
      normalizedSearch = "harvester";
    }

    const events = yield* fetchEvents();
    const match = selectEvent(events, normalizedSearch);
    if (!match) {
      return yield* Effect.succeed(
        `[Warn] No event or map found matching: ${normalizedSearch}`,
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
  },
  (self) =>
    Effect.mapError(self, (cause) => new CommandError({ cause })).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.catch((error) => Effect.succeed(error.message)),
      Effect.provide(CommandLayer),
    ),
);
