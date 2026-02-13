import fs from "node:fs/promises";
import path from "node:path";
import { RefreshingAuthProvider } from "@twurple/auth";
import { Config, Effect } from "effect";

export class AuthProvider extends Effect.Service<AuthProvider>()(
  "@arctools/twitch-bot/lib/auth/AuthProvider",
  {
    effect: Effect.gen(function* () {
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const accessToken = yield* Config.string("TWITCH_ACCESS_TOKEN");
      const clientSecret = yield* Config.string("TWITCH_CLIENT_SECRET");
      const refreshToken = yield* Config.string("TWITCH_REFRESH_TOKEN");

      const authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret,
      });

      yield* Effect.tryPromise({
        try: () =>
          authProvider.addUserForToken(
            {
              accessToken,
              refreshToken,
              expiresIn: null,
              obtainmentTimestamp: 0,
            },
            ["chat"],
          ),
        catch: (error) => Effect.logError(error),
      });

      authProvider.onRefresh(async (userId, newTokenData) => {
        await fs.writeFile(
          path.join(process.cwd(), `tokens.${userId}.json`),
          JSON.stringify(newTokenData, null, 4),
          "utf-8",
        );
      });

      return { authProvider } as const;
    }),
  },
) {}
