import { RefreshingAuthProvider } from "@twurple/auth";
import { Config, Effect, Schema } from "effect";
import { TokenRepository } from "./token-repository";

class AuthBootstrapError extends Schema.TaggedError<AuthBootstrapError>()(
  "AuthBootstrapError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class TwurpleAuthService extends Effect.Service<TwurpleAuthService>()(
  "@arctools/twitch-bot/services/TwurpleAuthService",
  {
    dependencies: [TokenRepository.Default],
    effect: Effect.gen(function* () {
      const tokenRepository = yield* TokenRepository;
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const clientSecret = yield* Config.string("TWITCH_CLIENT_SECRET");

      const authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret,
      });

      const stored = yield* tokenRepository.getToken;

      const resolvedUserId = yield* Effect.try({
        try: () => {
          authProvider.addUser(stored.userId, stored.tokenData, ["chat"]);
          return stored.userId;
        },
        catch: (cause) =>
          new AuthBootstrapError({ message: "Failed to add user", cause }),
      }).pipe(
        Effect.catchTag("AuthBootstrapError", () =>
          Effect.tryPromise({
            try: () => authProvider.addUserForToken(stored.tokenData, ["chat"]),
            catch: (cause) =>
              new AuthBootstrapError({
                message: "Failed to add user for token",
                cause,
              }),
          }),
        ),
      );

      if (resolvedUserId !== stored.userId) {
        yield* tokenRepository.upsertToken(resolvedUserId, stored.tokenData);
        yield* tokenRepository.deleteToken(stored.userId);
      }

      authProvider.onRefresh(async (userId, token) => {
        await tokenRepository.upsertToken(userId, token).pipe(
          Effect.tapBoth({
            onSuccess: () =>
              Effect.log(`Persisted refreshed token for user ${userId}`),
            onFailure: Effect.logError,
          }),
          Effect.catchAll(() => Effect.void),
          Effect.runPromise,
        );
      });

      authProvider.onRefreshFailure(async (userId, error) => {
        console.log("Failed to refresh token for user", userId, error);
      });

      return { authProvider, botUserId: resolvedUserId } as const;
    }),
  },
) {}
