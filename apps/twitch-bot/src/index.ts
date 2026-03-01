import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "@/services/auth";
import { twitchCommands } from "./commands";

const startTwitchBot = Effect.gen(function* () {
  yield* Effect.log("Twitch Bot starting...");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot", "k4rnivore"],
    commands: twitchCommands,
  });

  bot.onConnect(() =>
    Effect.log("Successfully connected to Twitch").pipe(Effect.runSync),
  );
  bot.onJoin((channel) =>
    Effect.log(`Joined ${channel.broadcasterName}`).pipe(Effect.runSync),
  );
}).pipe(Effect.withLogSpan("twitch_bot"), Effect.provide(AuthProvider.Default));

BunRuntime.runMain(startTwitchBot);
