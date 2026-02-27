import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Schema } from "effect";

class CommandReplyError extends Schema.TaggedError<CommandReplyError>()(
  "CommandReplyError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const twitchCommands = commands.map((def) =>
  createBotCommand(def.name, async (params, { reply }) => {
    return await Effect.gen(function* () {
      const search = parseMessageParams(params);
      const result = yield* def.handler(search);
      yield* Effect.log(`Command ${def.name} result: ${result}`);
      return yield* Effect.tryPromise({
        try: () => reply(result),
        catch: (error) =>
          new CommandReplyError({
            message: `Failed to reply to command ${def.name}`,
            cause: error,
          }),
      });
    }).pipe(Effect.tapError(Effect.logError), Effect.runPromise);
  }),
);

export { twitchCommands };
