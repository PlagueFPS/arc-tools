import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { BunRuntime } from "@effect/platform-bun";
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { Config, Data, Effect } from "effect";
import { SLASH_OPTION_NAME, toDiscordPayload } from "./slash-adapter.js";

const PREFIX = "!";

class CommandRegisterError extends Data.TaggedError("CommandRegisterError")<{
  message: string;
  cause?: unknown;
}> {}

async function runHandler(command: (typeof commands)[number], search: string) {
  return Effect.runPromise(command.handler(search));
}

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
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (cmd) => cmd.name === interaction.commandName,
    );
    if (!command) {
      return interaction.reply({
        content: "Command not found",
        ephemeral: true,
      });
    }

    const search = interaction.options.getString(SLASH_OPTION_NAME, true) ?? "";

    try {
      const result = await runHandler(command, search);
      await interaction.reply({ content: result });
    } catch (error) {
      console.error("Slash command error:", error);
      await interaction.reply({
        content: "[Error] Something went wrong. Please try again.",
        ephemeral: true,
      });
    }
  });

  client.on(Events.MessageCreate, async (message) => {
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

    try {
      const result = await runHandler(command, search);
      await message.reply(result);
    } catch (error) {
      console.error("Prefix command error:", error);
      await message.reply("[Error] Something went wrong. Please try again.");
    }
  });

  client.login(botToken);
});

BunRuntime.runMain(discordBot);
