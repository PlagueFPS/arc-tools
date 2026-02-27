import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Config, Effect, Option, Schema } from "effect";
import * as schema from "../db/schema";

class DrizzleConnectError extends Schema.TaggedError<DrizzleConnectError>()(
  "DrizzleConnectError",
  {
    cause: Schema.Unknown,
  },
) {}

export class DrizzleService extends Effect.Service<DrizzleService>()(
  "@arctools/twitch-bot/services/db/DrizzleService",
  {
    effect: Effect.gen(function* () {
      const url = yield* Config.string("TURSO_DATABASE_URL");
      const authToken = yield* Config.option(Config.string("TURSO_AUTH_TOKEN"));

      const client = createClient({
        url,
        authToken: Option.getOrUndefined(authToken),
      });

      const db = yield* Effect.try({
        try: () => drizzle(client, { schema }),
        catch: (cause) => new DrizzleConnectError({ cause }),
      });

      return db;
    }),
  },
) {}
