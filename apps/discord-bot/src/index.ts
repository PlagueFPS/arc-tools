import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { BunRuntime } from "@effect/platform-bun";
import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { Config, Effect, Schema } from "effect";
import { toDiscordPayload } from "./slash-adapter.js";

const PREFIX = "!";

class CommandRegisterError extends Schema.TaggedError<CommandRegisterError>()(
  "CommandRegisterError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

class ReplyError extends Schema.TaggedError<ReplyError>()("ReplyError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

const discordBot = Effect.gen(function* () {
  const botToken = yield* Config.string("DISCORD_BOT_TOKEN");
  const clientId = yield* Config.string("DISCORD_CLIENT_ID");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const rest = new REST().setToken(botToken);
  yield* Effect.log("Started refreshing application (/) commands.");

  const discordCommands = toDiscordPayload(commands);
  yield* Effect.tryPromise({
    try: () =>
      rest.put(Routes.applicationCommands(clientId), {
        body: discordCommands,
      }),
    catch: (error) =>
      new CommandRegisterError({
        message: "Failed to register commands",
        cause: error,
      }),
  });

  yield* Effect.log("Successfully registered application (/) commands.");

  client.on(Events.ClientReady, (c) =>
    console.log(`Logged in as ${c.user.tag}`),
  );

  client.on(Events.InteractionCreate, async (interaction) => {
    return await Effect.gen(function* () {
      if (!interaction.isChatInputCommand()) return;

      const command = commands.find(
        (cmd) => cmd.name === interaction.commandName,
      );
      if (!command) {
        return yield* Effect.tryPromise({
          try: () =>
            interaction.reply({
              content: "Command not found",
              ephemeral: true,
            }),
          catch: (cause) =>
            new ReplyError({
              message: "Failed to reply ephemerally to no command found.",
              cause,
            }),
        });
      }

      const firstOpt = command.slashOptions[0];
      const search = firstOpt
        ? (interaction.options.getString(
            firstOpt.name,
            firstOpt.required ?? true,
          ) ?? "")
        : "";

      const result = yield* command.handler(search);
      return yield* Effect.tryPromise({
        try: () => interaction.reply({ content: result }),
        catch: (cause) =>
          new ReplyError({
            message: `Failed to reply to command ${command.name}`,
            cause,
          }),
      });
    }).pipe(
      Effect.tapError((error) => Effect.logError(error)),
      Effect.runPromise,
    );
  });

  client.on(Events.MessageCreate, async (message) => {
    return await Effect.gen(function* () {
      if (message.author.bot) return;
      const content = message.content;
      if (!content.startsWith(PREFIX)) return;

      const args = content.slice(PREFIX.length).trim().split(/\s+/);
      const commandName = args[0]?.toLowerCase();
      const commandArgs = args.slice(1);

      if (!commandName) return;

      const command = commands.find(
        (cmd) => cmd.name.toLowerCase() === commandName,
      );
      if (!command) return;

      const search = parseMessageParams(commandArgs);
      const result = yield* command.handler(search);
      return yield* Effect.tryPromise({
        try: () => message.reply(result),
        catch: (cause) =>
          new ReplyError({
            message: `Failed to reply to command ${command.name}`,
            cause,
          }),
      });
    }).pipe(
      Effect.tapError((error) => Effect.logError(error)),
      Effect.runPromise,
    );
  });

  client.login(botToken);
}).pipe(Effect.withLogSpan("discord_bot"));

BunRuntime.runMain(discordBot);
