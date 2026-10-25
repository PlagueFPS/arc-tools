import { Effect } from "effect";

import { discordInstallPath } from "../route.js";
import { botClient } from "./bot.js";
import { discordInstallResponse } from "./discord-install.js";
import { enrollmentHead, websiteHttp } from "./enrollment.js";

const http = websiteHttp(botClient);

const handlers = new Map([
  [discordInstallPath, () => discordInstallResponse],
  ["/oauth/twitch/enroll", http.begin],
  ["/oauth/twitch/enroll/status", http.status],
  ["/oauth/twitch/callback", http.callback],
]);

export const enrollmentResponse = Effect.fnUntraced(function* (
  request: Request,
) {
  const handler = handlers.get(new URL(request.url).pathname);

  if (!handler) return undefined;

  if (request.method !== "GET") return enrollmentHead();

  return yield* handler(request);
});
