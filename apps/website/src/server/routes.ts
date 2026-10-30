import { Effect, HashMap, Option } from "effect";

import { botClient, canonicalWebsiteOrigin } from "./bot.js";
import { enrollmentHead, websiteHttp } from "./enrollment.js";

const http = websiteHttp(botClient, canonicalWebsiteOrigin);

const handlers = HashMap.make(
  ["/oauth/twitch/enroll", http.begin],
  ["/oauth/twitch/enroll/status", http.status],
  ["/oauth/twitch/callback", http.callback],
);

export const enrollmentResponse = Effect.fnUntraced(function* (
  request: Request,
) {
  const path = new URL(request.url).pathname;

  if (path === "/oauth/twitch/enroll/leave")
    return Option.some(yield* http.leave(request));
  const handler = HashMap.get(handlers, path);

  if (Option.isNone(handler)) return Option.none<Response>();

  if (request.method !== "GET") return Option.some(enrollmentHead());

  return Option.some(yield* handler.value(request));
});
