import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/twitch/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");

        if (!code) {
          return new Response("No code provided", { status: 400 });
        }

        const params = new URLSearchParams({
          client_id: process.env.TWITCH_CLIENT_ID || "",
          client_secret: process.env.TWITCH_CLIENT_SECRET || "",
          code,
          grant_type: "authorization_code",
          redirect_uri: "http://localhost:3000",
        });

        const response = await fetch(
          `https://id.twitch.tv/oauth2/token?${params.toString()}`,
          {
            method: "POST",
          },
        );

        const data = await response.json();

        console.log(data);

        return new Response("Token received", { status: 200 });
      },
    },
  },
});
