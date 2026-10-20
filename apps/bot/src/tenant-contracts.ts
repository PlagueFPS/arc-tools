import { CommandExecution } from "@arctools/commands";
import { Context, type Effect, Schema } from "effect";

import { BroadcasterId, GuildId, WorkId } from "./contracts.js";
import type { DiscordResponse } from "./presentation.js";
import { ReplyId } from "./twitch-contracts.js";

export const Invocation = Schema.Struct({
  command: CommandExecution.fields.command,
  input: CommandExecution.fields.input,
});

const receipt = {
  id: WorkId.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
  ),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  receivedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  invocation: Invocation,
};

export const TwitchReceipt = Schema.Struct({
  ...receipt,
  broadcasterId: BroadcasterId.check(Schema.isMaxLength(64)),
  replyParentId: ReplyId,
});

export type TwitchReceipt = typeof TwitchReceipt.Type;

export const DiscordReceipt = Schema.Struct({ ...receipt, guildId: GuildId });

export type DiscordReceipt = typeof DiscordReceipt.Type;

export const Admission = Schema.Struct({
  kind: Schema.Literals(["accepted", "duplicate"]),
});

export type Admission = typeof Admission.Type;

export class TenantError extends Schema.TaggedError<TenantError>()(
  "TenantError",
  { code: Schema.Literals(["input", "conflict", "capacity", "unavailable"]) },
) {}

export interface TenantService {
  readonly acceptTwitch: (
    receipt: TwitchReceipt,
  ) => Effect.Effect<Admission, TenantError>;
  readonly respondDiscord: (
    receipt: DiscordReceipt,
  ) => Effect.Effect<DiscordResponse, TenantError>;
}

export class Tenants extends Context.Service<Tenants, TenantService>()(
  "@arctools/Tenants",
) {}
