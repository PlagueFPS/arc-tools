import { Bot } from "@twurple/easy-bot";
import { Effect } from "effect";
import { twitchCommands } from "@/commands";
import { ChannelRepository } from "./channel-repository";
import { TwurpleAuthService } from "./twurple-auth";

const normalizeChannelLogin = (value: string) =>
  value.trim().toLowerCase().replace(/^#/, "");

export class TwitchBotService extends Effect.Service<TwitchBotService>()(
  "@arctools/twitch-bot/services/TwitchBotService",
  {
    dependencies: [TwurpleAuthService.Default, ChannelRepository.Default],
    effect: Effect.gen(function* () {
      const { authProvider } = yield* TwurpleAuthService;
      const channelRepository = yield* ChannelRepository;
      const desiredChannels = yield* channelRepository.listChannelLogins();
      const joinedChannels = new Set<string>();

      const run = Effect.gen(function* () {
        yield* Effect.log("Running Twitch Bot");
        const bot = new Bot({
          authProvider,
          channels: desiredChannels,
          commands: twitchCommands,
        });

        bot.onConnect(() =>
          console.log("Successfully connected to Twitch chat"),
        );

        bot.onDisconnect((manual, reason) => {
          console.warn(
            `Disconnected from Twitch chat (manual=${manual}): ${reason}`,
          );
        });

        bot.onJoin((channel) => {
          joinedChannels.add(normalizeChannelLogin(channel.broadcasterName));
          console.log(`Joined channel:${channel.broadcasterName}`);
        });

        bot.onJoinFailure((event) => {
          console.warn(
            `Join failed for channel:${event.broadcasterName}: ${event.reason}`,
          );
        });
      });

      return { run } as const;
    }),
  },
) {}
