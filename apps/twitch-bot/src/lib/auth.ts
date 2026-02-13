import { StaticAuthProvider } from "@twurple/auth";
import { Config, Effect } from "effect";

export class AuthProvider extends Effect.Service<AuthProvider>()(
  "@arctools/twitch-bot/lib/auth/AuthProvider",
  {
    effect: Effect.gen(function* () {
      const clientId = yield* Config.string("TWITCH_CLIENT_ID");
      const clientSecret = yield* Config.string("TWITCH_CLIENT_SECRET");

      const authProvider = new StaticAuthProvider(clientId, clientSecret);

      return { authProvider } as const;
    }),
  },
) {}
