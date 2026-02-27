import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { twitchChannels } from "../db/schema";
import { DrizzleService } from "./db";

const normalizeChannelLogin = (value: string) =>
  value.trim().toLowerCase().replace(/^#/, "");

class ChannelQueryError extends Schema.TaggedError<ChannelQueryError>()(
  "ChannelQueryError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class ChannelRepository extends Effect.Service<ChannelRepository>()(
  "@arctools/twitch-bot/services/ChannelRepository",
  {
    dependencies: [DrizzleService.Default],
    effect: Effect.gen(function* () {
      const db = yield* DrizzleService;

      const listChannels = Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(twitchChannels)
            .orderBy(asc(twitchChannels.joinedAt))
            .then((rows) =>
              rows.map((row) => ({
                broadcasterId: row.broadcasterId,
                broadcasterLogin: normalizeChannelLogin(row.broadcasterLogin),
                joinedAt: row.joinedAt,
              })),
            ),
        catch: (cause) =>
          new ChannelQueryError({ message: "Failed to list channels", cause }),
      });

      const listChannelLogins = listChannels.pipe(
        Effect.map((channels) => [
          ...new Set(channels.map((c) => c.broadcasterLogin)),
        ]),
      );

      const upsertChannel = (channel: {
        readonly broadcasterId: string;
        readonly broadcasterLogin: string;
      }) =>
        Effect.tryPromise({
          try: () =>
            db
              .insert(twitchChannels)
              .values({
                broadcasterId: channel.broadcasterId,
                broadcasterLogin: normalizeChannelLogin(
                  channel.broadcasterLogin,
                ),
                joinedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: twitchChannels.broadcasterId,
                set: {
                  broadcasterLogin: normalizeChannelLogin(
                    channel.broadcasterLogin,
                  ),
                },
              }),
          catch: (cause) =>
            new ChannelQueryError({
              message: "Failed to upsert channel",
              cause,
            }),
        }).pipe(Effect.asVoid);

      const removeChannel = (broadcasterId: string) =>
        Effect.tryPromise({
          try: () =>
            db
              .delete(twitchChannels)
              .where(eq(twitchChannels.broadcasterId, broadcasterId)),
          catch: (cause) =>
            new ChannelQueryError({
              message: "Failed to remove channel",
              cause,
            }),
        }).pipe(Effect.asVoid);

      return {
        listChannels: () => listChannels,
        listChannelLogins: () => listChannelLogins,
        upsertChannel,
        removeChannel,
      } as const;
    }),
  },
) {}
