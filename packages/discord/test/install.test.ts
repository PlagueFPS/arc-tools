import { expect, test } from "bun:test";

import { guildInstallUrl } from "@arctools/discord/install";
import { Effect, Array as Arr, Record as Rec } from "effect";

test("guild installation uses Discord authorization with only slash reply permissions", () => {
  const applicationId = "123456789012345678";
  const url = new URL(Effect.runSync(guildInstallUrl({ applicationId })));

  expect(url.origin).toBe("https://discord.com");
  expect(url.pathname).toBe("/oauth2/authorize");
  expect(Rec.fromEntries(url.searchParams)).toEqual({
    client_id: applicationId,
    scope: "bot applications.commands",
    integration_type: "0",
    permissions: "0",
  });
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.hash).toBe("");
});

test("application IDs retain their decimal precision and reject invalid snowflakes", () => {
  const applicationId = "18446744073709551615";
  expect(
    new URL(
      Effect.runSync(guildInstallUrl({ applicationId })),
    ).searchParams.get("client_id"),
  ).toBe(applicationId);

  for (const invalid of [
    "",
    "0",
    "012345678901234567",
    "-123456789012345678",
    "123456789012345678.0",
    "1e18",
    " 123456789012345678",
    "123456789012345678\n",
    "18446744073709551616",
    "123456789012345678901",
    "123456789012345678&permissions=8",
    "https://discord.com",
  ]) {
    const error = guildInstallUrl({ applicationId: invalid }).pipe(
      Effect.flip,
      Effect.runSync,
    );

    expect(error._tag).toBe("DiscordInstallError");
    expect(error.message).toBe(
      "Discord application ID must be a positive snowflake",
    );
  }
});

test("the public install entry builds for browsers with Effect and without server dependencies", async () => {
  const inputs: string[] = [];

  const result = await Bun.build({
    entrypoints: [new URL("./install-browser.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [
      {
        name: "inspect-discord-install-dependencies",
        setup(build) {
          build.onLoad({ filter: /./ }, (args) => {
            inputs.push(args.path);
          });
        },
      },
    ],
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(inputs).toContain(
    new URL("../src/install.ts", import.meta.url).pathname,
  );
  expect(Arr.some(inputs, (path) => !!/node_modules.*effect/.test(path))).toBe(
    true,
  );
  expect(
    Arr.some(
      inputs,
      (path) =>
        !!/alchemy|distilled|packages\/(commands|twitch|arc-data)\/|src\/(manifest|sync|server|http)\.ts$/.test(
          path,
        ),
    ),
  ).toBe(false);
});
