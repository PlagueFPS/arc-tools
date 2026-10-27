/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Schema } from "effect";

import {
  auditedObservation,
  registerLocalFixture,
} from "../tests/cloud/fixture-http.js";
import { cleanupLocalTest } from "./local-test-cleanup.js";
import {
  LocalTestSettings,
  localTestEnvironment,
  localTestSettings,
} from "./local-test-settings.js";

const stage = "test-tenant-12345678-0123456789ab";

const settings = localTestSettings({
  ARC_CLOUD_STAGE: stage,
  ARC_CLOUD_RUN: "0123456789ab",
});

test("local integration environment discards cloud credentials, mode overrides and application secrets", () => {
  const env = localTestEnvironment(
    {
      CLOUDFLARE_ACCOUNT_ID: "remote-account",
      CLOUDFLARE_API_TOKEN: "remote-token",
      CF_API_TOKEN: "remote-alias",
      ALCHEMY_PASSWORD: "remote-password",
      ALCHEMY_PROFILE: "prod",
      ALCHEMY_TEST_DEV: "false",
      ALCHEMY_DEV: "false",
      ALCHEMY_STAGE: "prod",
      TWITCH_CLIENT_SECRET: "live-secret",
      DISCORD_BOT_TOKEN: "live-token",
      ARC_BOT_URL: "https://production.invalid",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "github-alias",
      PATH: process.env.PATH,
    },
    settings,
  );

  expect(env.ALCHEMY_PROFILE).toBe("local-tests");
  expect(env.ALCHEMY_DEV).toBe("true");
  expect(env.ALCHEMY_TEST_DEV).toBeUndefined();
  expect(env.ALCHEMY_STAGE).toBeUndefined();
  expect(env.ALCHEMY_PASSWORD).toBeUndefined();
  expect(env.CI).toBe("true");
  expect(env.ALCHEMY_TELEMETRY_DISABLED).toBe("1");
  expect(env.ARC_BOT_URL).toBe("https://fixture.invalid");
  expect(env.TWITCH_CLIENT_SECRET).toBe("fixture-secret");
  expect(env.DISCORD_BOT_TOKEN).toBe("fixture-token");

  for (const key of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ])
    expect(env[key]).toBeUndefined();
  expect(env.PATH).toBe(process.env.PATH);
});

test("local settings reject cloud journals, mode overrides, mismatched stages and production", () => {
  const { dev: _, ...cloudJournal } = settings;
  expect(() =>
    Schema.decodeUnknownSync(LocalTestSettings)(cloudJournal),
  ).toThrow();

  for (const override of ["true", "false", "0"])
    expect(() =>
      localTestSettings({
        ARC_CLOUD_STAGE: stage,
        ARC_CLOUD_RUN: settings.run,
        ALCHEMY_TEST_DEV: override,
      }),
    ).toThrow("ALCHEMY_TEST_DEV");

  for (const changed of [
    { ARC_CLOUD_STAGE: "prod" },
    { ARC_CLOUD_RUN: "aaaaaaaaaaaa" },
    { ALCHEMY_STAGE: "prod" },
  ])
    expect(() =>
      localTestSettings({
        ARC_CLOUD_STAGE: stage,
        ARC_CLOUD_RUN: settings.run,
        ...changed,
      }),
    ).toThrow();
});

test("local observations retain fixture roles and audited paths", () => {
  const origin = "http://localhost:32123";
  expect(() =>
    auditedObservation("provider", `${origin}/snapshot`, Schema.Unknown),
  ).toThrow();
  registerLocalFixture("provider", origin);
  expect(
    auditedObservation(
      "provider",
      `${origin}/journeys/test/snapshot`,
      Schema.Unknown,
    ).url,
  ).toBe(`${origin}/journeys/test/snapshot`);
  expect(() =>
    auditedObservation("tenant", `${origin}/snapshot`, Schema.Unknown),
  ).toThrow();
  expect(() =>
    auditedObservation("provider", `${origin}/control`, Schema.Unknown),
  ).toThrow();
  expect(() =>
    registerLocalFixture("provider", "https://remote.invalid"),
  ).toThrow();
});

test("cleanup refuses a live local listener and removes only stopped runtime files while retaining evidence", async () => {
  const path = await mkdtemp(join(tmpdir(), "arc-local-infrastructure-"));
  const directory = pathToFileURL(`${path}/`);

  const server = Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch: () => new Response("local"),
  });

  try {
    await mkdir(new URL(".alchemy/", directory));
    await writeFile(new URL(".alchemy/state.json", directory), "{}");
    await writeFile(
      new URL("resources.json", directory),
      JSON.stringify({ stage, origins: [`http://localhost:${server.port}`] }),
    );
    await Promise.resolve(
      expect(cleanupLocalTest(directory, stage)).rejects.toThrow(
        "still running",
      ),
    );
    expect(
      await Bun.file(new URL(".alchemy/state.json", directory)).exists(),
    ).toBeTrue();
    await server.stop(true);
    await cleanupLocalTest(directory, stage);
    expect(
      await Bun.file(new URL(".alchemy/state.json", directory)).exists(),
    ).toBeFalse();
    expect(
      await Bun.file(new URL("resources.json", directory)).exists(),
    ).toBeTrue();
    await cleanupLocalTest(directory, stage);
    expect(
      cleanupLocalTest(directory, "test-tenant-aaaaaaaaaaaa"),
    ).rejects.toThrow("mismatch");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
