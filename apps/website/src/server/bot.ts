import { makeRpcStub } from "@alchemy.run/cloudflare/Bridge";
import type { BotOperations } from "@arctools/bot-contracts";
import { websiteOrigin } from "@arctools/bot-contracts/origins";
import { AccountError } from "@arctools/twitch/server";
import { Effect } from "effect";

import { WebsiteUnavailable } from "./errors.js";

export const botClient = Effect.gen(function* () {
  const { env } = yield* Effect.tryPromise({
    try: () => import("cloudflare:workers"),
    catch: () => new WebsiteUnavailable(),
  });

  if (!env.BOT) return yield* new WebsiteUnavailable();

  yield* Effect.try({
    try: () =>
      websiteOrigin(env.ARC_STAGE, env.ARC_WEBSITE_SELF, env.ARC_WEBSITE_URL),
    catch: () => new WebsiteUnavailable(),
  });

  return makeRpcStub<BotOperations>(env.BOT, { errors: [AccountError] });
});

export const canonicalWebsiteOrigin = Effect.gen(function* () {
  const { env } = yield* Effect.tryPromise({
    try: () => import("cloudflare:workers"),
    catch: () => new WebsiteUnavailable(),
  });

  return yield* Effect.try({
    try: () =>
      websiteOrigin(env.ARC_STAGE, env.ARC_WEBSITE_SELF, env.ARC_WEBSITE_URL),
    catch: () => new WebsiteUnavailable(),
  });
});
