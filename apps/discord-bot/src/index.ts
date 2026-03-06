import { commands } from "@arctools/commands";
import { BunRuntime } from "@effect/platform-bun";
import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { Config, Effect, Redacted, Schedule, Schema } from "effect";
import { handleInteractionCreate, handleMessageCreate } from "./events";
import { toDiscordPayload } from "./slash-adapter";

class CommandRegisterError extends Schema.TaggedErrorClass<CommandRegisterError>()(
  "CommandRegisterError",
  {
    cause: Schema.Unknown,
  },
) {}

class LoginError extends Schema.TaggedErrorClass<LoginError>()("LoginError", {
  cause: Schema.Unknown,
}) {}

const runDiscordBot = Effect.fn("DiscordBot")(function* () {
  const botToken = yield* Config.redacted("DISCORD_BOT_TOKEN");
  const clientId = yield* Config.string("DISCORD_CLIENT_ID");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const rest = new REST().setToken(Redacted.value(botToken));
  yield* Effect.log("Started refreshing application (/) commands.");

  const discordCommands = toDiscordPayload(commands);
  yield* Effect.tryPromise({
    try: () =>
      rest.put(Routes.applicationCommands(clientId), {
        body: discordCommands,
      }),
    catch: (cause) => new CommandRegisterError({ cause }),
  }).pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.fixed("200 millis"),
    }),
  );

  yield* Effect.log("Successfully registered application (/) commands.");

  client.on(Events.ClientReady, (c) =>
    console.log(`Logged in as ${c.user.tag}`),
  );

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    return await handleInteractionCreate(interaction).pipe(
      Effect.annotateLogs({ command: interaction.commandName }),
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.runPromise,
    );
  });

  client.on(Events.MessageCreate, async (message) => {
    return await handleMessageCreate(message).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.runPromise,
    );
  });

  yield* Effect.tryPromise({
    try: () => client.login(Redacted.value(botToken)),
    catch: (cause) => new LoginError({ cause }),
  });
});

runDiscordBot().pipe(Effect.orDie, BunRuntime.runMain);
