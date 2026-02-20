import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "@/lib/auth";
import { twitchCommands } from "./commands";

const startTwitchBot = Effect.gen(function* () {
  yield* Effect.log("Twitch Bot starting...");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot", "k4rnivore"],
    commands: twitchCommands,
  });

  bot.onConnect(() => console.log("Successfully connected to Twitch"));
  bot.onJoin((channel) => console.log(`Joined ${channel.broadcasterName}`));
}).pipe(Effect.provide(AuthProvider.Default));

BunRuntime.runMain(startTwitchBot);
