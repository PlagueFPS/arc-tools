import { Effect, Record as Rec } from "effect";
import { expect, test } from "vitest";

import { discordInstallHttp } from "./discord-install";
import { WebsiteUnavailable } from "./errors";

test("Discord installation redirects to the configured application's guild install", async () => {
  const response = await Effect.runPromise(
    discordInstallHttp(Effect.succeed("123456789012345678")),
  );

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  expect(location.origin + location.pathname).toBe(
    "https://discord.com/oauth2/authorize",
  );
  expect(Rec.fromEntries(location.searchParams)).toEqual({
    client_id: "123456789012345678",
    scope: "bot applications.commands",
    integration_type: "0",
    permissions: "0",
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test.each(["", "invalid"])(
  "invalid application ID %j returns unavailable without a redirect",
  async (applicationId) => {
    const response = await Effect.runPromise(
      discordInstallHttp(Effect.succeed(applicationId)),
    );

    expect(response.status).toBe(503);
    expect(response.headers.has("Location")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  },
);

test("a missing Worker environment returns unavailable", async () => {
  const response = await Effect.runPromise(
    discordInstallHttp(new WebsiteUnavailable()),
  );

  expect(response.status).toBe(503);
  expect(await response.text()).toContain(
    "Discord installation is unavailable",
  );
});
