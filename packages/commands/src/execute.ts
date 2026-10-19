import { ArcData, type DataRead, DataUnavailable } from "@arctools/arc-data";
import { Clock, Effect, Predicate, Ref, Schema } from "effect";
import { CommandError } from "./lib/command-error.js";
import { commands } from "./registry.js";

export const CommandName = Schema.Literals(
  commands.map((command) => command.name),
);
export type CommandName = typeof CommandName.Type;
export const CommandExecution = Schema.Struct({
  command: CommandName,
  input: Schema.String.check(Schema.isMaxLength(256)),
  deadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CommandExecution = typeof CommandExecution.Type;
export interface CommandReply {
  readonly text: string;
  readonly stale: boolean;
}

export const executeCommand = Effect.fn("Command.execute")(function* (
  request: CommandExecution,
) {
  const input = yield* Schema.decodeUnknownEffect(CommandExecution)(
    request,
  ).pipe(Effect.mapError((cause) => new CommandError({ cause })));
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
    traders: () => observe(data.traders()),
    events: () => observe(data.events()),
  });
  const command = commands.find((command) => command.name === input.command);
  if (Predicate.isUndefined(command))
    return yield* new CommandError({ cause: "Unknown command" });
  const text = yield* command.handler(input.input).pipe(
    Effect.provideService(ArcData, local),
    Effect.timeout(remaining),
    Effect.catch(
      Effect.fnUntraced(function* (cause) {
        return yield* new CommandError({
          cause: cause._tag === "CommandError" ? cause.cause : cause,
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
