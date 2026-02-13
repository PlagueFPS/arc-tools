import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "@/lib/auth";
import { find } from "./commands/find";
import { recycleTo } from "./commands/recycle-to";

const startTwitchBot = Effect.gen(function* () {
  yield* Effect.log("Twitch Bot starting...");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot"],
    commands: [recycleTo, find],
  });

  bot.onConnect(() => console.log("Successfully connected to Twitch"));
  bot.onJoin((channel) => console.log(`Joined ${channel.broadcasterName}`));
}).pipe(Effect.provide(AuthProvider.Default));

BunRuntime.runMain(startTwitchBot);
