import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "@/services/auth";
import { twitchCommands } from "./twitch-commands";

const runTwitchBot = Effect.fn("TwitchBot")(function* () {
  yield* Effect.log("Twitch Bot Running..");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot", "k4rnivore"],
    commands: twitchCommands,
  });

  bot.onConnect(() => console.log("Successfully connected to Twitch"));
  bot.onJoin((channel) => console.log(`Joined ${channel.broadcasterName}`));
});

runTwitchBot().pipe(Effect.provide(AuthProvider.layer), BunRuntime.runMain);
