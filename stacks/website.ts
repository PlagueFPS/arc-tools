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
  assets: { htmlHandling: "none", notFoundHandling: "none" },
  // Alchemy 2.0.0-beta.83 `Website.Foldkit` forwards only main, rootDir, and
  // memo. It cannot select an unbuilt worker environment. `static` is not
  // built, and the website Vite plugin drops the in-memory ssr bundle after
  // prerender, so this worker ships the generated client files only.
  viteEnvironments: { entry: "static" },
});
