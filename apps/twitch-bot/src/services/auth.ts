import { RefreshingAuthProvider } from "@twurple/auth";
import { eq } from "drizzle-orm";
import { Config, Effect, Schedule, Schema } from "effect";
import { twitchTokens } from "@/db/schema";
import { Database } from "@/services/db";

const TokenDataSchema = Schema.Struct({
  accessToken: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("access_token"),
  ),
  refreshToken: Schema.propertySignature(Schema.NullOr(Schema.String)).pipe(
    Schema.fromKey("refresh_token"),
  ),
  expiresIn: Schema.propertySignature(Schema.NullOr(Schema.Number)).pipe(
    Schema.fromKey("expires_in"),
  ),
  obtainmentTimestamp: Schema.propertySignature(Schema.Number).pipe(
    Schema.fromKey("obtainment_timestamp"),
  ),
  scope: Schema.parseJson(Schema.mutable(Schema.Array(Schema.String))),
});

const decodeTokenData = Schema.decodeUnknown(TokenDataSchema);

class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class AuthProvider extends Effect.Service<AuthProvider>()(
  "@arctools/twitch-bot/lib/auth/AuthProvider",
  {
    dependencies: [Database.Default],
    effect: Effect.gen(function* () {
      const db = yield* Database;
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const clientSecret = yield* Config.string("TWITCH_CLIENT_SECRET");
      const initialAccessToken = yield* Config.string(
        "TWITCH_INITIAL_ACCESS_TOKEN",
      );
      const initialRefreshToken = yield* Config.string(
        "TWITCH_INITIAL_REFRESH_TOKEN",
      );
      const botUserId = yield* Config.string("TWITCH_BOT_USER_ID");

      const tokenDataFromDB = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              access_token: twitchTokens.access_token,
              refresh_token: twitchTokens.refresh_token,
              expires_in: twitchTokens.expires_in,
              obtainment_timestamp: twitchTokens.obtainment_timestamp,
              scope: twitchTokens.scope,
            })
            .from(twitchTokens)
            .where(eq(twitchTokens.bot_user_id, botUserId))
            .get(),
        catch: (cause) =>
          new DatabaseError({
            message: "Failed to query token data from database",
            cause,
          }),
      });

      const authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret,
      });

      if (!tokenDataFromDB) {
        const userId = yield* Effect.tryPromise({
          try: () =>
            authProvider.addUserForToken(
              {
                accessToken: initialAccessToken,
                refreshToken: initialRefreshToken,
                expiresIn: 0,
                obtainmentTimestamp: 0,
              },
              ["chat"],
            ),
          catch: (cause) =>
            new AuthError({ message: "Failed to add user for token", cause }),
        }).pipe(
          Effect.tap((userId) =>
            Effect.log(`Added user for token ${userId} using initial tokens`),
          ),
        );

        // Force refresh after initialization to get token data
        const tokenData = yield* Effect.tryPromise({
          try: () => authProvider.refreshAccessTokenForUser(userId),
          catch: (cause) =>
            new AuthError({ message: "Failed to refresh access token", cause }),
        }).pipe(
          Effect.tap(() =>
            Effect.log(`Refreshed access token for user ${userId}`),
          ),
        );

        yield* Effect.tryPromise({
          try: () =>
            db.insert(twitchTokens).values({
              bot_user_id: userId,
              access_token: tokenData.accessToken,
              refresh_token: tokenData.refreshToken,
              expires_in: tokenData.expiresIn,
              obtainment_timestamp: tokenData.obtainmentTimestamp,
              scope: JSON.stringify(tokenData.scope),
              updated_at: new Date(),
            }),
          catch: (cause) =>
            new DatabaseError({
              message: "Failed to insert token data into database",
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.log(`Inserted token data for user ${userId}`),
          ),
        );
      } else {
        const tokenData = yield* decodeTokenData(tokenDataFromDB);
        yield* Effect.tryPromise({
          try: () => authProvider.addUserForToken(tokenData, ["chat"]),
          catch: (cause) =>
            new AuthError({ message: "Failed to add user for token", cause }),
        }).pipe(
          Effect.tap((userId) =>
            Effect.log(
              `Added user for token ${userId} using token data from database`,
            ),
          ),
        );
      }

      authProvider.onRefresh(async (userId, newTokenData) => {
        return await Effect.tryPromise({
          try: () =>
            db
              .update(twitchTokens)
              .set({
                access_token: newTokenData.accessToken,
                refresh_token: newTokenData.refreshToken,
                expires_in: newTokenData.expiresIn,
                obtainment_timestamp: newTokenData.obtainmentTimestamp,
                scope: JSON.stringify(newTokenData.scope),
                updated_at: new Date(),
              })
              .where(eq(twitchTokens.bot_user_id, userId)),
          catch: (cause) =>
            new DatabaseError({
              message: "Failed to update token data in database",
              cause,
            }),
        }).pipe(
          Effect.retry({
            times: 3,
            schedule: Schedule.fixed("200 millis"),
          }),
          Effect.tapBoth({
            onSuccess: () =>
              Effect.log(`Persisted refreshed token for user ${userId}`),
            onFailure: (cause) => Effect.logError(cause),
          }),
          Effect.catchAll(() => Effect.void),
          Effect.runPromise,
        );
      });

      authProvider.onRefreshFailure((userId, error) =>
        Effect.logError(
          `Failed to refresh token for user ${userId}:`,
          error,
        ).pipe(Effect.runSync),
      );

      return { authProvider } as const;
    }),
  },
) {}
