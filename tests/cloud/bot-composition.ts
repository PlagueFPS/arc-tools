import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import type { EnvironmentConfig } from "../../apps/bot/src/config.js";
import { AccountEndpoints } from "../../apps/bot/src/twitch.js";
import { CacheSource } from "../../packages/arc-data/src/cloudflare.js";
import { MetaforgeWorker } from "./metaforge.js";
import { TwitchProviderFixture } from "./twitch-provider-fixture.js";

export const botTestBindings = Effect.fnUntraced(function* (
  identity: EnvironmentConfig,
) {
  if (identity.kind !== "test" || !identity.stage.startsWith("test-tenant-"))
    return yield* Effect.die(
      "Bot fixtures require an isolated synthetic tenant test stage",
    );
  const source = yield* Cloudflare.Worker(MetaforgeWorker.LogicalId, {});
  const provider = yield* Cloudflare.Worker(
    TwitchProviderFixture.LogicalId,
    {},
  );
  const sourceUrl = yield* source.url;
  const providerUrl = yield* provider.url;
  return Layer.merge(
    Layer.succeed(CacheSource, {
      options: Effect.gen(function* () {
        const baseUrl = yield* sourceUrl;
        if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://"))
          return yield* Effect.die("Synthetic source URL unavailable");
        return { baseUrl };
      }),
    }),
    Layer.succeed(AccountEndpoints, {
      resolve: Effect.gen(function* () {
        const baseUrl = yield* providerUrl;
        if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://"))
          return yield* Effect.die("Synthetic provider URL unavailable");
        return { api: `${baseUrl}/helix`, oauth: `${baseUrl}/oauth` };
      }),
    }),
  );
});
