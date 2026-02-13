import { BunRuntime } from "@effect/platform-bun";
import { Bot, createBotCommand } from "@twurple/easy-bot";
import { Effect } from "effect";
import { AuthProvider } from "@/lib/auth";

const startTwitchBot = Effect.gen(function* () {
  yield* Effect.log("Twitch Bot starting...");
  const { authProvider } = yield* AuthProvider;

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot"],
    commands: [
      createBotCommand("help", (params, { reply }) => {
        reply("How can I help?");
      }),
    ],
  });

  bot.onConnect(() => console.log("Connected to Twitch"));
}).pipe(Effect.provide(AuthProvider.Default));

BunRuntime.runMain(startTwitchBot);
