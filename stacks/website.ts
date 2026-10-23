import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Effect } from "effect";

export const websiteDevelopment = Output.named(
  Output.fromEffect(Effect.map(AlchemyContext, ({ dev }) => dev)),
  "ARC_WEBSITE_DEV",
);

export const Website = Cloudflare.Website.Vite("Website", {
  rootDir: "apps/website",
  workersDev: false,
  assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "none" },
});
