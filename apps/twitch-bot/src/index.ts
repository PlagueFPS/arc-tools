import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "./services/auth.js";
import { twitchCommands } from "./twitch-commands.js";

const runTwitchBot = Effect.fn("TwitchBot")(function* () {
  yield* Effect.log("Twitch Bot Running..");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot", "k4rnivore"],
    commands: twitchCommands,
  });

  bot.onConnect(() =>
    Effect.runFork(Effect.log("Successfully connected to Twitch")),
  );
  bot.onJoin((channel) =>
    Effect.runFork(Effect.log(`Joined ${channel.broadcasterName}`)),
  );
});

runTwitchBot().pipe(
  Effect.provide(AuthProvider.layer),
  Effect.orDie,
  BunRuntime.runMain,
);
