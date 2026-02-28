import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const twitchTokens = sqliteTable("twitch_tokens", {
  id: integer("id").primaryKey(),
  bot_user_id: text("bot_user_id").notNull(),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token"),
  expires_in: integer("expires_in"),
  obtainment_timestamp: integer("obtainment_timestamp").notNull(),
  scope: text("scope", { mode: "json" }).notNull(),
  updated_at: integer("updated_at", { mode: "timestamp" }).$onUpdate(
    () => new Date(),
  ),
});
