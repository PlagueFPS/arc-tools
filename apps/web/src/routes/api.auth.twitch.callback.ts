import { createFileRoute } from "@tanstack/react-router";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const redirectUri = `${APP_URL}/api/auth/twitch/callback`;

export const Route = createFileRoute("/api/auth/twitch/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const errorParam = url.searchParams.get("error");

        if (errorParam) {
          return Response.redirect(`${APP_URL}/?error=auth_denied`);
        }

        if (!code) {
          return new Response("No code provided", { status: 400 });
        }

        const tokenParams = new URLSearchParams({
          client_id: process.env.TWITCH_CLIENT_ID || "",
          client_secret: process.env.TWITCH_CLIENT_SECRET || "",
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });

        const tokenRes = await fetch(
          `https://id.twitch.tv/oauth2/token?${tokenParams.toString()}`,
          { method: "POST" },
        );

        const tokenData = (await tokenRes.json()) as {
          access_token?: string;
          error?: string;
          message?: string;
        };

        if (!tokenRes.ok || !tokenData.access_token) {
          const msg =
            tokenData.message ?? tokenData.error ?? "Token exchange failed";
          return Response.redirect(
            `${APP_URL}/?error=${encodeURIComponent(msg)}`,
          );
        }

        const validateRes = await fetch(
          "https://id.twitch.tv/oauth2/validate",
          {
            headers: { Authorization: `OAuth ${tokenData.access_token}` },
          },
        );

        if (!validateRes.ok) {
          return Response.redirect(`${APP_URL}/?error=validate_failed`);
        }

        const validateData = (await validateRes.json()) as { login?: string };
        const channel = validateData.login;

        if (!channel) {
          return Response.redirect(`${APP_URL}/?error=no_login`);
        }

        const botJoinApiUrl = process.env.BOT_JOIN_API_URL;
        const botJoinSecret = process.env.BOT_JOIN_SECRET;

        if (botJoinApiUrl && botJoinSecret) {
          try {
            const joinRes = await fetch(
              `${botJoinApiUrl.replace(/\/$/, "")}/internal/join`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Bot-Join-Secret": botJoinSecret,
                },
                body: JSON.stringify({ channel }),
              },
            );

            if (!joinRes.ok) {
              const err = await joinRes.json().catch(() => ({}));
              return Response.redirect(
                `${APP_URL}/?error=${encodeURIComponent((err as { error?: string }).error ?? "join_failed")}`,
              );
            }
          } catch {
            return Response.redirect(`${APP_URL}/?error=bot_unreachable`);
          }
        }

        return Response.redirect(`${APP_URL}/?added=true`);
      },
    },
  },
});
