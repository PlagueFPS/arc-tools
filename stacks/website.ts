import * as Cloudflare from "alchemy/Cloudflare";
import type { InferEnv } from "alchemy/Cloudflare/Bridge";
import { Config, Effect } from "effect";

import { Bot } from "../apps/bot/src/worker.js";

export const Website = Effect.gen(function* () {
  const bot = yield* Bot;

  return yield* Cloudflare.Website.Vite("Website", {
    rootDir: "apps/website",
    workersDev: true,
    assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "none" },
    env: {
      BOT: bot,
      ARC_WEBSITE_URL: Config.NonEmptyString("ARC_WEBSITE_URL"),
      ARC_WEBSITE_SELF: Cloudflare.Worker.URL,
      ARC_STAGE: Config.NonEmptyString("ARC_STAGE"),
    },
  });
});

export type WebsiteEnv = InferEnv<typeof Website>;
