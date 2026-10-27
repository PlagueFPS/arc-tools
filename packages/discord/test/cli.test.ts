import { expect, test } from "bun:test";

const run = async (scenario: string, preflight = false) => {
  const process = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "--preload",
      new URL("./fixtures/sync-cli.ts", import.meta.url).pathname,
      new URL("../../../scripts/sync-discord-commands.ts", import.meta.url)
        .pathname,
      "--stage",
      "prod",
      "--endpoint",
      "https://release.invalid",
      "--revision",
      "revision",
      ...(preflight ? ["--preflight"] : []),
    ],
    {
      env: {
        PATH: Bun.env.PATH,
        DISCORD_APPLICATION_ID: "fixture",
        DISCORD_BOT_TOKEN: "canary-token",
        SYNC_SCENARIO: scenario,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect(stdout + stderr).not.toContain("canary");

  return { exitCode, stdout, stderr };
};

test("the preflight CLI reports rejected authentication without health checks, retries, or mutations", async () => {
  const result = await run("auth", true);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({
    event: "discord-sync-failure",
    operation: "preflight",
    code: "provider",
    status: 401,
    discordCode: 50001,
    retryCount: 0,
  });
  expect(result.stdout.match(/fixture-request/g)).toHaveLength(1);
  expect(result.stdout).not.toContain('"operation":"health"');
  expect(result.stdout).not.toContain('"method":"PUT"');
});

test("the preflight CLI succeeds before a new revision has been deployed", async () => {
  const result = await run("stale", true);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"event":"discord-preflight-success"');
  expect(result.stdout).not.toContain('"operation":"health"');
});

test("the sync CLI retains typed readiness diagnostics and makes no provider mutation for a stale revision", async () => {
  const result = await run("stale");
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({
    code: "stale-release",
    operation: "health",
    status: 200,
    attempt: 1,
  });
  expect(result.stdout).not.toContain('"operation":"commands"');
});

test("the actual sync CLI recovers a lost overwrite response without writing twice", async () => {
  const result = await run("lost-write");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.match(/"method":"PUT"/g)).toHaveLength(1);
  expect(result.stdout).toContain('"changed":true');
  expect(result.stdout).toContain("discord-sync-retry");
  expect(result.stderr).toBe("");
});
