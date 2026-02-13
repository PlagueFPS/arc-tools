import { StaticAuthProvider } from "@twurple/auth";
import { Config, Effect } from "effect";

export class AuthProvider extends Effect.Service<AuthProvider>()(
  "@arctools/twitch-bot/lib/auth/AuthProvider",
  {
    effect: Effect.gen(function* () {
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const accessToken = yield* Config.string("TWITCH_ACCESS_TOKEN");
      // const refreshToken = yield* Config.string("TWITCH_REFRESH_TOKEN");

      const authProvider = new StaticAuthProvider(clientId, accessToken);

      return { authProvider } as const;
    }),
  },
) {}
