import { commands } from "@arctools/commands";
import { Schema } from "effect";

export const TwitchId = Schema.String.check(
  Schema.isPattern(/^\d{1,32}$/),
).pipe(Schema.brand("TwitchUserId"));
export const DiscordId = Schema.String.check(
  Schema.isPattern(/^\d{1,32}$/),
).pipe(Schema.brand("DiscordSnowflake"));
export const DeliveryId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/),
);
export const WebhookSecret = Schema.String.check(
  Schema.isPattern(/^\p{ASCII}{10,100}$/u),
);
export const Token = Schema.NonEmptyString.check(Schema.isMaxLength(2048));
export const CommandName = Schema.Literals(
  commands.map((command) => command.name),
);
const call = { command: CommandName, input: Schema.String };
const twitchTarget = {
  kind: Schema.Literal("twitch"),
  broadcasterId: TwitchId,
  messageId: DeliveryId,
};
const discordTarget = {
  kind: Schema.Literal("discord"),
  guildId: DiscordId,
  applicationId: DiscordId,
  interactionId: DiscordId,
  token: Token,
};
export const TwitchWork = Schema.Struct({
  ...twitchTarget,
  deliveryId: DeliveryId,
  ...call,
});
export const DiscordWork = Schema.Struct({
  ...discordTarget,
  expiresAt: Schema.Number.check(Schema.isFinite()),
  ...call,
});
export const BotWork = Schema.Union([TwitchWork, DiscordWork]);
export type BotWork = typeof BotWork.Type;
export const ReplyTarget = Schema.Union([
  Schema.Struct(twitchTarget),
  Schema.Struct(discordTarget),
]);
export type ReplyTarget = typeof ReplyTarget.Type;
const progress = {
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  deadline: Schema.Number.check(Schema.isFinite()),
};
export const Job = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("execute"),
    work: BotWork,
    ...progress,
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    target: ReplyTarget,
    text: Schema.String,
    ...progress,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    expiresAt: Schema.Number.check(Schema.isFinite()),
  }),
]);
export type Job = typeof Job.Type;
export const CallbackKey = Schema.Struct({ key: DeliveryId });
export const JobJson = Schema.fromJsonString(Job);
export const ERROR_TEXT = "Something went wrong while executing your command!";
export const MAX_ATTEMPTS = 5;
export const JOB_LIFETIME = 10 * 60_000;
export const TOMBSTONE_LIFETIME = 24 * 60 * 60_000;
