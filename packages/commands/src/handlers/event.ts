import { getEvents, selectEvent } from "@arctools/arc-data";
import { formatMinutes, normalize } from "@arctools/utils";
import { Clock, Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";

export const eventHandler = Effect.fn("Command.eventHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an event or map name (e.g. '!event Prospecting Probes')",
      );
    }

    let normalizedSearch = normalize(search);
    if (normalizedSearch.includes("queen")) {
      normalizedSearch = "harvester";
    }

    const match = yield* getEvents().pipe(
      Effect.flatMap((events) => selectEvent(events, normalizedSearch)),
    );
    if (Option.isNone(match)) {
      return yield* Effect.succeed(
        `[Warn] No event or map found matching: ${normalizedSearch}`,
      );
    }

    const now = yield* Clock.currentTimeMillis;
    const base = `${match.value.name} on ${match.value.map}`;

    if (match.value.startTime <= now && now <= match.value.endTime) {
      const remaining = match.value.endTime - now;
      return yield* Effect.succeed(
        `${base} is active now (ends in ${formatMinutes(remaining)})`,
      );
    }

    const startsIn = match.value.startTime - now;
    return yield* Effect.succeed(
      `${base} starts in ${formatMinutes(startsIn)}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
