import * as Cloudflare from "alchemy/Cloudflare";
import type { InferEnv } from "alchemy/Cloudflare/Bridge";
import { Config, Effect } from "effect";

import { configuredWebsiteOrigin } from "../apps/bot/src/config.js";
import { Bot } from "../apps/bot/src/worker.js";

export const Website = Effect.gen(function* () {
  const bot = yield* Bot;

  return yield* Cloudflare.Website.Vite("Website", {
    rootDir: "apps/website",
    workersDev: true,
    dev: { port: 3000, strictPort: true },
    assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "none" },
    env: {
      BOT: bot,
      ARC_WEBSITE_URL: configuredWebsiteOrigin,
      ARC_WEBSITE_SELF: Cloudflare.Worker.URL,
      ARC_STAGE: Config.NonEmptyString("ARC_STAGE"),
    },
  });
});

export type WebsiteEnv = InferEnv<typeof Website>;
