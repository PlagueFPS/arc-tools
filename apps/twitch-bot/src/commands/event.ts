import { createBotCommand } from "@twurple/easy-bot";
import { Effect } from "effect";
import { fetchEvents, selectEvent } from "@/data/events";
import { CommandRuntime } from "@/lib/layers";
import { parseMessageParams } from "@/lib/utils";

function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export const event = createBotCommand("event", async (params, { reply }) => {
  return Effect.gen(function* () {
    const search = parseMessageParams(params);
    if (!search) {
      return yield* Effect.succeed(
        reply(
          "Please provide an event or map name (e.g. '!event Prospecting Probes')",
        ),
      );
    }

    const events = yield* fetchEvents();
    const match = selectEvent(events, search);
    if (!match) {
      return yield* Effect.succeed(
        reply(`[Warn] No event or map found matching: ${search}`),
      );
    }

    const now = Date.now();
    const base = `${match.name} on ${match.map}`;

    if (match.startTime <= now && now <= match.endTime) {
      const remaining = match.endTime - now;
      return yield* Effect.succeed(
        reply(`${base} is active now (ends in ${formatMinutes(remaining)})`),
      );
    }

    const startsIn = match.startTime - now;
    return yield* Effect.succeed(
      reply(`${base} starts in ${formatMinutes(startsIn)}`),
    );
  }).pipe(
    Effect.withLogSpan("event_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() =>
      Effect.succeed(reply("[Error] Unable to fetch event data")),
    ),
    Effect.ensureErrorType<never>(),
    CommandRuntime.runPromise,
  );
});
