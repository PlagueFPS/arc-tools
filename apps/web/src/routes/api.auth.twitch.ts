import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/twitch")({
  server: {
    handlers: {
      GET: async () => {
        const params = new URLSearchParams({
          client_id: process.env.TWITCH_CLIENT_ID || "",
          redirect_uri: "http://localhost:3000/api/auth/twitch/callback",
          response_type: "code",
          scope: "chat:edit chat:read",
        });

        const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;

        return Response.redirect(url);
      },
    },
  },
});
