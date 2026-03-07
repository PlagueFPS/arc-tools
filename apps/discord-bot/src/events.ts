import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import type {
  CacheType,
  ChatInputCommandInteraction,
  Message,
  OmitPartialGroupDMChannel,
} from "discord.js";
import { Array as Arr, Effect, Option, Schema } from "effect";

class ReplyError extends Schema.TaggedErrorClass<ReplyError>()("ReplyError", {
  cause: Schema.Unknown,
}) {}

const COMMAND_PREFIX = "!";

export const handleInteractionCreate = Effect.fn("handleInteractionCreate")(
  function* (interaction: ChatInputCommandInteraction<CacheType>) {
    const command = Arr.findFirst(
      commands,
      (cmd) => cmd.name === interaction.commandName,
    );

    if (Option.isNone(command)) {
      return yield* Effect.tryPromise({
        try: () =>
          interaction.reply({
            content: "Command not found",
            flags: "Ephemeral",
          }),
        catch: (cause) => new ReplyError({ cause }),
      });
    }

    const search = parseMessageParams(
      command.value.slashOptions.flatMap((option) => {
        const value = interaction.options.getString(
          option.name,
          option.required,
        );
        return value ? [value] : [];
      }),
    );

    const result = yield* command.value.handler({ search });
    return yield* Effect.tryPromise({
      try: () => interaction.reply({ content: result }),
      catch: (cause) => new ReplyError({ cause }),
    });
  },
  (self, interaction) =>
    Effect.catchTag(self, "CommandError", (cause) =>
      Effect.tryPromise({
        try: () =>
          interaction.reply({ content: cause.message, flags: "Ephemeral" }),
        catch: (cause) => new ReplyError({ cause }),
      }),
    ),
);

export const handleMessageCreate = Effect.fn("handleMessageCreate")(function* (
  message: OmitPartialGroupDMChannel<Message<boolean>>,
) {
  if (message.author.bot) return;

  const { content } = message;
  if (!content.startsWith(COMMAND_PREFIX)) return;

  const args = content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const commandName = Arr.get(args, 0).pipe(Option.map((s) => s.toLowerCase()));
  const commandArgs = Arr.drop(args, 1);

  if (Option.isNone(commandName)) return;

  const command = Arr.findFirst(
    commands,
    (cmd) => cmd.name.toLowerCase() === commandName.value,
  );

  if (Option.isNone(command)) return;

  const search = parseMessageParams(commandArgs);
  const result = yield* command.value
    .handler({ search })
    .pipe(
      Effect.catchTag("CommandError", (error) => Effect.succeed(error.message)),
    );

  return yield* Effect.tryPromise({
    try: () => message.reply({ content: result }),
    catch: (cause) => new ReplyError({ cause }),
  });
});
