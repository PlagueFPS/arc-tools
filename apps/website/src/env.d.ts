/// <reference types="@cloudflare/workers-types" />

import type { InferEnv } from "@alchemy.run/cloudflare/Bridge";
import type { BotOperations } from "@arctools/bot-contracts";
import type { Rpc } from "alchemy/Rpc";

type WebsiteEnv = InferEnv<{
  BOT: Rpc<BotOperations>;
  DISCORD_APPLICATION_ID: string;
  ARC_STAGE: string;
  ARC_WEBSITE_SELF: string;
  ARC_WEBSITE_URL: string;
}>;

declare global {
  namespace Cloudflare {
    interface Env extends WebsiteEnv {}
  }
}
