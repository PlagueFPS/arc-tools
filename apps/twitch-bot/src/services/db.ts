import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import * as schema from "../db/schema.js";

export class Database extends Context.Service<Database>()(
  "twitch-bot/services/db/Database",
  {
    make: Effect.gen(function* () {
      const url = yield* Config.String("TURSO_CONNECTION_URL");
      const authToken = yield* Config.option(
        Config.Redacted("TURSO_AUTH_TOKEN"),
      );
      const client = createClient({
        url,
        authToken: Option.map(authToken, (token) => Redacted.value(token)).pipe(
          Option.getOrUndefined,
        ),
      });
      const db = drizzle(client, { schema });
      return db;
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}
