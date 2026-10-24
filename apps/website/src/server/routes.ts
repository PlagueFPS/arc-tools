import { Effect } from "effect";

import { botClient } from "./bot.js";
import { enrollmentHead, websiteHttp } from "./enrollment.js";

const http = websiteHttp(botClient);

const handlers = new Map([
  ["/oauth/twitch/enroll", http.begin],
  ["/oauth/twitch/enroll/status", http.status],
  ["/oauth/twitch/callback", http.callback],
]);

export const enrollmentResponse = async (request: Request) => {
  const handler = handlers.get(new URL(request.url).pathname);

  if (!handler) return undefined;

  if (request.method !== "GET") return enrollmentHead();

  return Effect.runPromise(handler(request));
};
