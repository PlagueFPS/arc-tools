/// <reference types="@cloudflare/workers-types" />

import type { WebsiteEnv } from "../../../stacks/website.js";

declare global {
  namespace Cloudflare {
    interface Env extends WebsiteEnv {}
  }
}
