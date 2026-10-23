import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { botClient } from "../server/bot.js";
import { enrollmentHead, websiteHttp } from "../server/enrollment.js";

export const Route = createFileRoute("/oauth/twitch/enroll")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Effect.runPromise(websiteHttp(botClient).begin(request)),
      HEAD: enrollmentHead,
    },
  },
});
