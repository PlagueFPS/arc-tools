import type { AccessToken } from "@twurple/auth";
import { desc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { twitchTokens } from "../db/schema";
import { DrizzleService } from "./db";

class TokenNotFoundError extends Schema.TaggedError<TokenNotFoundError>()(
  "TokenNotFoundError",
  {
    message: Schema.String,
  },
) {}

class TokenDecodeError extends Schema.TaggedError<TokenDecodeError>()(
  "TokenDecodeError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

class TokenQueryError extends Schema.TaggedError<TokenQueryError>()(
  "TokenQueryError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const AccessTokenSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresIn: Schema.NullOr(Schema.Number),
  obtainmentTimestamp: Schema.Number,
  scope: Schema.mutable(Schema.Array(Schema.String)),
});

const decodeAccessToken = Schema.decodeUnknown(AccessTokenSchema);

export class TokenRepository extends Effect.Service<TokenRepository>()(
  "@arctools/twitch-bot/services/TokenRepository",
  {
    dependencies: [DrizzleService.Default],
    effect: Effect.gen(function* () {
      const db = yield* DrizzleService;

      const getToken = Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(twitchTokens)
              .orderBy(desc(twitchTokens.updatedAt))
              .limit(1),
          catch: (cause) =>
            new TokenQueryError({ message: "Failed to load token", cause }),
        });
        const row = rows[0];

        if (!row) {
          return yield* Effect.fail(
            new TokenNotFoundError({
              message: "No twitch token found in twitch_tokens table",
            }),
          );
        }

        const tokenData = yield* Effect.try({
          try: () => JSON.parse(row.scopeJson),
          catch: (cause) =>
            new TokenDecodeError({
              message: "Failed to parse scope JSON",
              cause,
            }),
        }).pipe(
          Effect.map((scope) => ({
            accessToken: row.accessToken,
            refreshToken: row.refreshToken,
            expiresIn: row.expiresIn,
            obtainmentTimestamp: row.obtainmentTimestamp,
            scope,
          })),
          Effect.andThen((data) => decodeAccessToken(data)),
        );

        return { userId: row.userId, tokenData } as const;
      });

      const upsertToken = (userId: string, token: AccessToken) =>
        Effect.tryPromise({
          try: () =>
            db
              .insert(twitchTokens)
              .values({
                userId,
                accessToken: token.accessToken,
                refreshToken: token.refreshToken,
                expiresIn: token.expiresIn,
                obtainmentTimestamp: token.obtainmentTimestamp,
                scopeJson: JSON.stringify(token.scope),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: twitchTokens.userId,
                set: {
                  accessToken: token.accessToken,
                  refreshToken: token.refreshToken,
                  expiresIn: token.expiresIn,
                  obtainmentTimestamp: token.obtainmentTimestamp,
                  scopeJson: JSON.stringify(token.scope),
                  updatedAt: new Date(),
                },
              }),
          catch: (cause) =>
            new TokenQueryError({ message: "Failed to upsert token", cause }),
        }).pipe(Effect.asVoid);

      const deleteToken = (userId: string) =>
        Effect.tryPromise({
          try: () =>
            db.delete(twitchTokens).where(eq(twitchTokens.userId, userId)),
          catch: (cause) =>
            new TokenQueryError({ message: "Failed to delete token", cause }),
        }).pipe(Effect.asVoid);

      return { getToken, upsertToken, deleteToken } as const;
    }),
  },
) {}
