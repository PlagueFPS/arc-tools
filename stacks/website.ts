import * as Cloudflare from "@alchemy.run/cloudflare";
import type { InferEnv } from "@alchemy.run/cloudflare/Bridge";
import { Stage } from "alchemy/Stage";
import { Config, Effect } from "effect";

import { configuredWebsiteOrigin } from "../apps/bot/src/config.js";
import { Bot } from "../apps/bot/src/worker.js";

export const Website = Effect.gen(function* () {
  const bot = yield* Bot;
  const stage = yield* Stage;

  return yield* Cloudflare.Website.Vite("Website", {
    name: `arc-tools-website-${stage}`,
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
