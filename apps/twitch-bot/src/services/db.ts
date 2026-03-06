import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Config, Effect, Layer, Option, ServiceMap } from "effect";
import * as schema from "@/db/schema";

export class Database extends ServiceMap.Service<Database>()(
  "twitch-bot/services/db/Database",
  {
    make: Effect.gen(function* () {
      const url = yield* Config.string("TURSO_CONNECTION_URL");
      const authToken = yield* Config.option(Config.string("TURSO_AUTH_TOKEN"));
      const client = createClient({
        url,
        authToken: Option.getOrUndefined(authToken),
      });
      const db = drizzle(client, { schema });
      return db;
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}
