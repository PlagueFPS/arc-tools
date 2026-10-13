import { Config, Effect, Schema } from "effect";
import { DiscordId, TwitchId, WebhookSecret } from "./domain.ts";

const IngressConfig = Schema.Struct({
  discordApplicationId: DiscordId,
  discordPublicKey: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/)),
  twitchBotId: TwitchId,
  twitchSecret: WebhookSecret,
  twitchChannels: Schema.Array(TwitchId).check(Schema.isMinLength(1)),
});
export const ingressConfig = Effect.gen(function* () {
  const config = yield* Config.all({
    discordApplicationId: Config.String("DISCORD_APPLICATION_ID"),
    discordPublicKey: Config.String("DISCORD_PUBLIC_KEY"),
    twitchBotId: Config.String("TWITCH_BOT_USER_ID"),
    twitchSecret: Config.String("TWITCH_WEBHOOK_SECRET"),
    twitchChannels: Config.String("TWITCH_CHANNEL_IDS"),
  });
  return yield* Schema.decodeUnknownEffect(IngressConfig)({
    ...config,
    twitchChannels: config.twitchChannels.split(",").map((id) => id.trim()),
  });
}).pipe(
  Effect.mapError(() => "Invalid ingress configuration"),
  Effect.orDie,
);

export const twitchCredentials = Config.all({
  clientId: Config.String("TWITCH_CLIENT_ID"),
  clientSecret: Config.String("TWITCH_CLIENT_SECRET"),
  botId: Config.String("TWITCH_BOT_USER_ID"),
}).pipe(Effect.orDie);

export const workerCompatibility = {
  date: "2026-10-06",
  flags: ["nodejs_compat"],
};
