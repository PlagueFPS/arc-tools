import { CommandName } from "@arctools/commands/schemas";
import { BroadcasterId, Deadline } from "@arctools/twitch/server";
import { Schema } from "effect";

export { CommandName };

const identifier = Schema.NonEmptyString;

export const GuildId = identifier.pipe(Schema.brand("GuildId"));

export const WorkId = identifier.pipe(Schema.brand("WorkId"));

export const TenantKey = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("twitch"),
    broadcasterId: BroadcasterId,
  }),
  Schema.Struct({ transport: Schema.Literal("discord"), guildId: GuildId }),
]);

export type TenantKey = typeof TenantKey.Type;

export const tenantName = (key: TenantKey) =>
  key.transport === "twitch"
    ? `twitch:${key.broadcasterId}`
    : `discord:${key.guildId}`;

export const CommandInput = Schema.Struct({
  command: CommandName,
  input: Schema.String,
  deadline: Deadline,
});

export type CommandInput = typeof CommandInput.Type;

export type GuildId = typeof GuildId.Type;

export type WorkId = typeof WorkId.Type;

export const budgets = {
  discordInitialResponseMs: 3_000,
  twitchSendCutoffMs: 10_000,
  metadataFreshMs: 24 * 60 * 60 * 1_000,
  metadataFallbackMs: 7 * 24 * 60 * 60 * 1_000,
  scheduleFreshMs: 60_000,
} as const;
