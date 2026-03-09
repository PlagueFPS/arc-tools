import { RefreshingAuthProvider } from "@twurple/auth";
import { eq } from "drizzle-orm";
import {
  Config,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
  ServiceMap,
} from "effect";
import { twitchTokens } from "@/db/schema";
import { Database } from "@/services/db";

const TokenDataSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresIn: Schema.NullOr(Schema.Int),
  obtainmentTimestamp: Schema.Int,
  scope: Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String))),
}).pipe(
  Schema.encodeKeys({
    accessToken: "access_token",
    refreshToken: "refresh_token",
    expiresIn: "expires_in",
    obtainmentTimestamp: "obtainment_timestamp",
  }),
);

/** Decodes snake_case DB row to token data. Exported for testing. */
export const decodeTokenData = Schema.decodeUnknownEffect(TokenDataSchema);

class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Unknown,
  },
) {}

class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  cause: Schema.Unknown,
}) {}

export class AuthProvider extends ServiceMap.Service<AuthProvider>()(
  "twitch-bot/services/auth/AuthProvider",
  {
    make: Effect.gen(function* () {
      const db = yield* Database;
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const clientSecret = yield* Config.redacted("TWITCH_CLIENT_SECRET");
      const initialAccessToken = yield* Config.redacted(
        "TWITCH_INITIAL_ACCESS_TOKEN",
      );
      const initialRefreshToken = yield* Config.redacted(
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
        catch: (cause) => new DatabaseError({ cause }),
      });

      const authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret: Redacted.value(clientSecret),
      });

      if (!tokenDataFromDB) {
        const userId = yield* Effect.tryPromise({
          try: () =>
            authProvider.addUserForToken(
              {
                accessToken: Redacted.value(initialAccessToken),
                refreshToken: Redacted.value(initialRefreshToken),
                expiresIn: 0,
                obtainmentTimestamp: 0,
              },
              ["chat"],
            ),
          catch: (cause) => new AuthError({ cause }),
        }).pipe(
          Effect.tap((userId) =>
            Effect.log(`Added user for token ${userId} using initial tokens`),
          ),
        );

        if (userId !== botUserId)
          return yield* new AuthError({
            cause: `user id: ${userId} does not match bot user id: ${botUserId}`,
          });

        // Force refresh after initialization to get token data
        const tokenData = yield* Effect.tryPromise({
          try: () => authProvider.refreshAccessTokenForUser(userId),
          catch: (cause) => new AuthError({ cause }),
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
          catch: (cause) => new DatabaseError({ cause }),
        }).pipe(
          Effect.tap(() =>
            Effect.log(`Inserted token data for user ${userId}`),
          ),
        );
      } else {
        const tokenData = yield* decodeTokenData(tokenDataFromDB);
        const userId = yield* Effect.tryPromise({
          try: () => authProvider.addUserForToken(tokenData, ["chat"]),
          catch: (cause) => new AuthError({ cause }),
        }).pipe(
          Effect.tap((userId) =>
            Effect.log(
              `Added user for token ${userId} using token data from database`,
            ),
          ),
        );

        if (userId !== botUserId)
          return yield* new AuthError({
            cause: `user id: ${userId} does not match bot user id: ${botUserId}`,
          });
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
          catch: (cause) => new DatabaseError({ cause }),
        }).pipe(
          Effect.retry({
            times: 3,
            schedule: Schedule.fixed("200 millis"),
          }),
          Effect.tap(() =>
            Effect.log(`Persisted refreshed token for user ${userId}`),
          ),
          Effect.tapCause((cause) => Effect.logError(cause)),
          Effect.ignore,
          Effect.runPromise,
        );
      });

      authProvider.onRefreshFailure((userId, error) =>
        Effect.runFork(
          Effect.logError(`Failed to refresh token for user ${userId}`, {
            message: error.message,
            cause: error.cause,
          }),
        ),
      );

      return { authProvider } as const;
    }),
  },
) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Database.layer),
  );
}
