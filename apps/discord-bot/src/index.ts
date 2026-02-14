import { commands } from "@arctools/commands";
import { BunRuntime } from "@effect/platform-bun";
import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { Config, Data, Effect } from "effect";

class CommandRegisterError extends Data.TaggedError("CommandRegisterError")<{
  message: string;
  cause?: unknown;
}> {}

const discordBot = Effect.gen(function* () {
  const botToken = yield* Config.string("DISCORD_BOT_TOKEN");
  const clientId = yield* Config.string("DISCORD_CLIENT_ID");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const rest = new REST().setToken(botToken);
  yield* Effect.log("Started refreshing application (/) commands.");

  yield* Effect.tryPromise({
    try: () =>
      rest.put(Routes.applicationCommands(clientId), {
        body: commands,
      }),
    catch: (error) =>
      new CommandRegisterError({
        message: "Failed to register commands",
        cause: error,
      }),
  });

  yield* Effect.log("Successfully registered application (/) commands.");

  client.on(Events.ClientReady, (client) =>
    console.log(`Logged in as ${client.user.tag}`),
  );
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (cmd) => cmd.name === interaction.commandName,
    );
    if (!command)
      return await interaction.reply({
        content: "Command not found",
        ephemeral: true,
      });
  });

  client.login(botToken);
});

BunRuntime.runMain(discordBot);
