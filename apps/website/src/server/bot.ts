import type { toRpcAsync } from "@alchemy.run/cloudflare/Bridge";
import { AccountError } from "@arctools/twitch/server";
import { createServerOnlyFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { websiteOrigin } from "../../../bot/src/origins.js";
import type { BotOperations } from "../../../bot/src/rpc.js";
import type { Bot } from "../../../bot/src/worker.js";
import type {} from "../env.js";
import { WebsiteUnavailable } from "./errors.js";

const getBot = createServerOnlyFn(async () => {
  const { env } = await import("cloudflare:workers");
  websiteOrigin(env.ARC_STAGE, env.ARC_WEBSITE_SELF, env.ARC_WEBSITE_URL);
  const { toRpcAsync } = await import("@alchemy.run/cloudflare/Bridge");

  return toRpcAsync<Bot>(env.BOT);
});

const call = Effect.fnUntraced(function* <A>(operation: () => Promise<A>) {
  return yield* Effect.tryPromise({
    try: operation,
    catch: (error) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(AccountError)(error),
        () => new AccountError({ code: "provider" }),
      ),
  });
});

export const botOperationsClient = (
  bot: ReturnType<typeof toRpcAsync<Bot>>,
): BotOperations => ({
  enrollmentBegin: (input) => call(() => bot.enrollmentBegin(input)),
  enrollmentComplete: (input) => call(() => bot.enrollmentComplete(input)),
  enrollmentStatus: (session) => call(() => bot.enrollmentStatus(session)),
  completeOperatorOAuth: (input) =>
    call(() => bot.completeOperatorOAuth(input)),
});

export const botClient = Effect.tryPromise({
  try: getBot,
  catch: () => new WebsiteUnavailable(),
}).pipe(Effect.map(botOperationsClient));
