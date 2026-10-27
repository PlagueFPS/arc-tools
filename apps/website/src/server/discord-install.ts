import { guildInstallUrl } from "@arctools/discord/install";
import { Config, Effect } from "effect";

import { WebsiteUnavailable } from "./errors.js";

export const discordInstallHttp = <R>(
  applicationId: Effect.Effect<string, WebsiteUnavailable, R>,
) =>
  applicationId.pipe(
    Effect.flatMap((applicationId) => guildInstallUrl({ applicationId })),
    Effect.map(
      (location) =>
        new Response(null, {
          status: 302,
          headers: { Location: location, "Cache-Control": "no-store" },
        }),
    ),
    Effect.catchTags({
      DiscordInstallError: () => Effect.succeed(unavailable()),
      WebsiteUnavailable: () => Effect.succeed(unavailable()),
    }),
  );

const unavailable = () =>
  new Response("Discord installation is unavailable. Please try again later.", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });

export const discordInstallResponse = discordInstallHttp(
  Effect.tryPromise({
    try: (): Promise<Pick<typeof import("cloudflare:workers"), "env">> =>
      import("cloudflare:workers"),
    catch: () => new WebsiteUnavailable(),
  }).pipe(
    Effect.map(({ env }) => env.DISCORD_APPLICATION_ID),
    Effect.catchTag("WebsiteUnavailable", () =>
      Config.NonEmptyString("DISCORD_APPLICATION_ID").pipe(
        Effect.mapError(() => new WebsiteUnavailable()),
      ),
    ),
  ),
);
