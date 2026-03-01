import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Schema } from "effect";

class ReplyError extends Schema.TaggedError<ReplyError>()("ReplyError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

const twitchCommands = commands.map((def) =>
  createBotCommand(def.name, async (params, { reply }) => {
    return await Effect.gen(function* () {
      const search = parseMessageParams(params);
      const result = yield* def.handler(search);
      return yield* Effect.tryPromise({
        try: () => reply(result),
        catch: (cause) =>
          new ReplyError({
            message: `Failed to reply to ${def.name} command`,
            cause,
          }),
      });
    }).pipe(
      Effect.tapError(Effect.logError),
      Effect.catchAll(() => Effect.void),
      Effect.runPromise,
    );
  }),
);

export { twitchCommands };
