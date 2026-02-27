import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const twitchTokens = sqliteTable("twitch_tokens", {
  userId: text("user_id").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresIn: integer("expires_in"),
  obtainmentTimestamp: integer("obtainment_timestamp").notNull(),
  scopeJson: text("scope_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$onUpdate(
    () => new Date(),
  ),
});

export const twitchChannels = sqliteTable("twitch_channels", {
  broadcasterId: text("broadcaster_id").primaryKey(),
  broadcasterLogin: text("broadcaster_login").notNull(),
  joinedAt: integer("joined_at", { mode: "timestamp" }).notNull(),
});
