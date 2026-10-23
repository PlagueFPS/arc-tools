import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { botClient } from "../server/bot.js";
import { enrollmentHead, websiteHttp } from "../server/enrollment.js";

export const Route = createFileRoute("/oauth/twitch/enroll/status")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Effect.runPromise(websiteHttp(botClient).status(request)),
      HEAD: enrollmentHead,
    },
  },
});
