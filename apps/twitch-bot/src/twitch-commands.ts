import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Schedule, Schema } from "effect";

class ReplyError extends Schema.TaggedErrorClass<ReplyError>()("ReplyError", {
  cause: Schema.Unknown,
}) {}

export const twitchCommands = commands.map((def) =>
  createBotCommand(def.name, async (params, { reply }) => {
    return await Effect.gen(function* () {
      const search = parseMessageParams(params);
      const result = yield* def.handler(search);
      return yield* Effect.tryPromise({
        try: () => reply(result),
        catch: (cause) => new ReplyError({ cause }),
      }).pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.fixed("200 millis"),
        }),
      );
    }).pipe(
      Effect.annotateLogs({ command: def.name }),
      Effect.catchTag("CommandError", (error) =>
        Effect.tryPromise({
          try: () => reply(error.message),
          catch: (cause) => new ReplyError({ cause }),
        }).pipe(
          Effect.retry({
            times: 3,
            schedule: Schedule.fixed("200 millis"),
          }),
        ),
      ),
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.ignore,
      Effect.runPromise,
    );
  }),
);
