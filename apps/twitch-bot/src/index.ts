import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Console, Effect, Layer } from "effect";
import { twitchCommands } from "./commands";
import { ChannelRepository } from "./services/channel-repository";
import { TwurpleAuthService } from "./services/twurple-auth";

const RunTwitchBotLayer = Layer.mergeAll(
  TwurpleAuthService.Default,
  ChannelRepository.Default,
);

const runTwitchBot = Effect.gen(function* () {
  const { authProvider } = yield* TwurpleAuthService;
  const channelRepository = yield* ChannelRepository;
  const desiredChannels = yield* channelRepository.listChannelLogins();

  yield* Console.log("Running Twitch Bot");
  const bot = new Bot({
    authProvider,
    channels: desiredChannels,
    commands: twitchCommands,
  });

  bot.onConnect(() => console.log("Successfully connected to Twitch chat"));

  bot.onDisconnect((manual, reason) => {
    console.warn(`Disconnected from Twitch chat (manual=${manual}): ${reason}`);
  });

  bot.onJoin((channel) => {
    console.log(`Joined channel:${channel.broadcasterName}`);
  });

  bot.onJoinFailure((event) => {
    console.warn(
      `Join failed for channel:${event.broadcasterName}: ${event.reason}`,
    );
  });

  bot.onMessageFailed((channel, reason) => {
    console.warn(`Message failed in channel:${channel}: ${reason}`);
  });

  bot.chat.onMessageRatelimit((channel, text) => {
    console.warn(`Message ratelimited in channel:${channel}: ${text}`);
  });
}).pipe(Effect.provide(RunTwitchBotLayer));

BunRuntime.runMain(runTwitchBot);
