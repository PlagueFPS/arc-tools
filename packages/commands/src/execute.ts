import { ArcData, type DataRead, DataUnavailable } from "@arctools/arc-data";
import { Clock, Effect, Predicate, Ref, Schema } from "effect";

import { commandHandlers } from "./handlers.js";
import { CommandError } from "./lib/command-error.js";
import { CommandExecution } from "./schemas.js";

export interface CommandReply {
  readonly text: string;
  readonly stale: boolean;
}

export const executeCommand = Effect.fn("Command.execute")(function* (
  request: CommandExecution,
) {
  const input = yield* Schema.decodeEffect(CommandExecution)(request).pipe(
    Effect.mapError((cause) => new CommandError({ cause })),
  );

  const remaining = input.deadline - (yield* Clock.currentTimeMillis);

  if (remaining <= 0)
    return yield* new CommandError({
      cause: new DataUnavailable({ resource: "command", reason: "deadline" }),
    });
  const data = yield* ArcData;
  const stale = yield* Ref.make(false);

  const observe = <A>(read: Effect.Effect<DataRead<A>, DataUnavailable>) =>
    read.pipe(
      Effect.tap((result) =>
        result.provenance.freshness === "fallback"
          ? Ref.set(stale, true)
          : Effect.void,
      ),
    );

  const local = ArcData.of({
    items: (params) => observe(data.items(params)),
    arcs: (params) => observe(data.arcs(params)),
    traders: observe(data.traders),
    events: observe(data.events),
  });

  const text = yield* commandHandlers[input.command](input.input).pipe(
    Effect.provideService(ArcData, local),
    Effect.timeout(remaining),
    Effect.catch(
      Effect.fnUntraced(function* (cause) {
        return yield* new CommandError({
          cause: Predicate.isTagged(cause, "CommandError")
            ? cause.cause
            : cause,
          stale: yield* Ref.get(stale),
        });
      }),
    ),
  );

  const usedFallback = yield* Ref.get(stale);

  if ((yield* Clock.currentTimeMillis) >= input.deadline)
    return yield* new CommandError({
      cause: new DataUnavailable({ resource: "command", reason: "deadline" }),
      stale: usedFallback,
    });

  return {
    text: usedFallback ? `${text} [Using cached data]` : text,
    stale: usedFallback,
  } satisfies CommandReply;
});
