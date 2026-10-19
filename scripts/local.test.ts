import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { localAction, localSettings, plan, runPlan } from "./local.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const fixtureEnv = {
  ARC_STAGE: "local-fixture",
  APPLICATION_STAGE: "local-fixture",
  ARC_ENVIRONMENT: "personal",
  ARC_PUBLIC_URL: "https://first.invalid",
  ARC_BUILD_REVISION: "fixture-revision",
  ALCHEMY_PROFILE: "fixture-profile",
  TWITCH_SENDER_KIND: "personal",
  TWITCH_SENDER_LOGIN: "fixture_sender",
  TWITCH_CHANNEL_LOGINS: "fixture_sender",
  TWITCH_CLIENT_ID: "fixture-twitch",
  TWITCH_CLIENT_SECRET: "fixture-secret",
  TWITCH_SIGNING_SECRET: "fixture-signing",
  DISCORD_APPLICATION_ID: "fixture-discord",
  DISCORD_BOT_TOKEN: "fixture-token",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  OPERATOR_SECRET: "fixture-operator",
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local settings", () => {
  test("file keys replace stale exports, absent keys fall back, and dotenv quotes work", async () => {
    const directory = await temporary();
    const envFile = join(directory, ".env.local");
    await writeFile(
      envFile,
      `${dotenv(fixtureEnv)}\nARC_PUBLIC_URL='https://quoted.invalid' # public\nEXTRA_SECRET="fixture-file-secret"\nEXTRA_SECRET_999999="fixture-numbered-secret"\nEMPTY_SECRET=\n`,
    );
    const { settings, env } = await localSettings(envFile, {
      ...fixtureEnv,
      ARC_STAGE: "prod",
      APPLICATION_STAGE: "staging",
      ARC_PUBLIC_URL: "https://stale.invalid",
      ARC_BUILD_REVISION: "stale-revision",
      ALCHEMY_PROFILE: "stale-profile",
      TWITCH_CLIENT_SECRET: "stale-secret",
      EXTRA_SECRET: "stale-extra",
      EMPTY_SECRET: "stale-empty",
      CLOUDFLARE_API_TOKEN: "fixture-shell-token",
      UNRELATED: "fixture-unrelated",
    });
    expect(settings).toEqual({
      stage: "local-fixture",
      endpoint: "https://quoted.invalid",
      revision: "fixture-revision",
      profile: "fixture-profile",
    });
    expect(env).toMatchObject({
      ...fixtureEnv,
      ARC_PUBLIC_URL: settings.endpoint,
      EXTRA_SECRET: "fixture-file-secret",
      EXTRA_SECRET_999999: "fixture-numbered-secret",
      EMPTY_SECRET: "",
      CLOUDFLARE_API_TOKEN: "fixture-shell-token",
      UNRELATED: "fixture-unrelated",
    });
    await writeFile(envFile, "ARC_PUBLIC_URL=https://second.invalid\n");
    expect((await localSettings(envFile, fixtureEnv)).settings.endpoint).toBe(
      "https://second.invalid",
    );
  });

  test("only an absent revision defaults and an absent profile leaves Alchemy's selection alone", async () => {
    const directory = await temporary();
    const envFile = join(directory, ".env.local");
    const {
      ARC_BUILD_REVISION: _revision,
      ALCHEMY_PROFILE: _profile,
      ...env
    } = fixtureEnv;
    await writeFile(envFile, dotenv(env));
    const resolved = await localSettings(envFile, {});
    expect(resolved.settings.revision).toBe("unreleased");
    expect(resolved.env.ARC_BUILD_REVISION).toBe("unreleased");
    expect(plan("dev", resolved.settings)[0]).not.toContain("--profile");
    await writeFile(envFile, `${dotenv(fixtureEnv)}\nARC_BUILD_REVISION=\n`);
    await expect(localSettings(envFile, fixtureEnv)).rejects.toThrow(
      "ARC_BUILD_REVISION",
    );
  });
});

describe("local package aliases", () => {
  test("changing only the file twice updates every child, setup orders sync before private OAuth output, and all aliases work", async () => {
    const fixture = await launcherFixture();
    const stale = {
      ...fixtureEnv,
      ARC_STAGE: "prod",
      APPLICATION_STAGE: "prod",
      ARC_PUBLIC_URL: "https://stale.invalid",
      ARC_BUILD_REVISION: "stale-revision",
      ALCHEMY_PROFILE: "stale-profile",
      OPERATOR_SECRET: "stale-operator",
      DISCORD_BOT_TOKEN: "stale-token",
    };
    for (const origin of ["https://first.invalid", "https://second.invalid"]) {
      await writeFile(
        join(fixture.directory, ".env.local"),
        dotenv({ ...fixtureEnv, ARC_PUBLIC_URL: origin }),
      );
      for (const alias of [
        "dev:local",
        "setup:local",
        "status:local",
        "sync:discord:local",
      ]) {
        const result = await fixture.run(alias, stale);
        expect(result.code).toBe(0);
        expect(result.output).not.toContain("fixture-operator");
        if (alias === "dev:local") {
          expect(result.output).toContain(`${origin}/interactions/discord`);
          expect(result.output).toContain(`${origin}/oauth/twitch/callback`);
        }
        if (alias === "setup:local")
          expect(
            result.output.trim().endsWith("fixture-private-oauth-link"),
          ).toBeTrue();
      }
      const calls = await fixture.calls();
      const latest = calls.slice(-5);
      expect(latest.map((call) => call.kind)).toEqual([
        "dev",
        "sync",
        "ops",
        "ops",
        "sync",
      ]);
      for (const call of latest) {
        expect(call.env).toEqual({ ...fixtureEnv, ARC_PUBLIC_URL: origin });
        expect(call.cwd).toBe(fixture.directory);
        expect(call.execPath).toBe(process.execPath);
        expect(call.args).not.toContain("fixture-operator");
        expect(call.args).toContain("local-fixture");
      }
      expect(latest[0]?.args).toEqual([
        "dev",
        "--stage",
        "local-fixture",
        "--env-file",
        join(fixture.directory, ".env.local"),
        "--profile",
        "fixture-profile",
      ]);
      expect(latest[1]?.args).toEqual([
        "--stage",
        "local-fixture",
        "--endpoint",
        origin,
        "--revision",
        "fixture-revision",
        "--wait",
      ]);
      expect(latest[2]?.args).toEqual([
        "setup",
        "--stage",
        "local-fixture",
        "--endpoint",
        origin,
      ]);
      expect(latest[3]?.args).toEqual([
        "status",
        "--stage",
        "local-fixture",
        "--endpoint",
        origin,
        "--discord",
        "--revision",
        "fixture-revision",
      ]);
    }
  }, 30000);

  test("first failure propagates and setup never starts the second child", async () => {
    const fixture = await launcherFixture();
    const result = await fixture.run("setup:local", { FAIL_SYNC: "23" });
    expect(result.code).toBe(23);
    expect((await fixture.calls()).map((call) => call.kind)).toEqual(["sync"]);
    expect(result.output).not.toContain("fixture-private-oauth-link");
  });

  test("invalid config, missing file, unknown actions, and extra args run no children and hide values", async () => {
    const fixture = await launcherFixture();
    const changes = [
      {
        ARC_STAGE: "prod",
        APPLICATION_STAGE: "prod",
        ARC_ENVIRONMENT: "production",
        TWITCH_SENDER_KIND: "bot",
      },
      { ARC_STAGE: "staging", APPLICATION_STAGE: "staging" },
      {
        ARC_STAGE: "test-fixture-0123456789ab",
        APPLICATION_STAGE: "test-fixture-0123456789ab",
      },
      { APPLICATION_STAGE: "local-other" },
      { ARC_ENVIRONMENT: "production" },
      { TWITCH_SENDER_KIND: "bot" },
      { TWITCH_CHANNEL_LOGINS: "other" },
      { TWITCH_CHANNEL_LOGINS: "fixture_sender,other" },
      ...[
        "http://fixture.invalid",
        "https://fixture.invalid/path",
        "https://fixture.invalid?secret=CANARY",
        "https://fixture.invalid/#CANARY",
        "https://CANARY:password@fixture.invalid",
        "CANARY-NOT-URL",
      ].map((ARC_PUBLIC_URL) => ({ ARC_PUBLIC_URL })),
      { ARC_BUILD_REVISION: "" },
      { ALCHEMY_PROFILE: "" },
      { DISCORD_PUBLIC_KEY: "CANARY-BAD-KEY" },
    ];
    for (const change of changes) {
      await writeFile(
        join(fixture.directory, ".env.local"),
        dotenv({ ...fixtureEnv, ...change }),
      );
      const result = await fixture.run("setup:local");
      expect(result.code).toBe(1);
      expect(result.output).toContain("Invalid local configuration");
      expect(result.output).not.toContain("CANARY");
      expect(result.output).not.toContain("fixture-secret");
    }
    await rm(join(fixture.directory, ".env.local"));
    const missing = await fixture.run("setup:local");
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Cannot read .env.local");
    for (const args of [
      ["unknown"],
      ["setup", "--stage", "local-fixture"],
      [],
    ]) {
      expect(() => localAction(args)).toThrow("without extra arguments");
      const result = await fixture.run(args);
      expect(result.code).toBe(1);
      expect(result.output).toContain("without extra arguments");
    }
    expect(await fixture.calls()).toEqual([]);
  }, 30000);
});

describe("sequential local runner", () => {
  test("successful children finish before the next child starts", async () => {
    const directory = await temporary();
    const log = join(directory, "order");
    const code = await runPlan(
      [
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `await Bun.write(${JSON.stringify(log)}, 'first'); await Bun.sleep(20);`,
        ],
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `if (await Bun.file(${JSON.stringify(log)}).text() !== 'first') process.exit(8); await Bun.write(${JSON.stringify(log)}, 'second');`,
        ],
      ],
      { cwd: directory, env: {} },
    );
    expect(code).toBe(0);
    expect(await readFile(log, "utf8")).toBe("second");
  });

  for (const { signal, hold, group } of [
    { signal: "SIGINT", hold: "graceful", group: false },
    { signal: "SIGTERM", hold: "graceful", group: false },
    { signal: "SIGINT", hold: "graceful", group: true },
    { signal: "SIGTERM", hold: "stubborn", group: false },
  ] as const) {
    test(`${group ? "process group" : "direct"} ${signal} stops a ${hold} child and its descendant, exits, and skips setup's next step`, async () => {
      const fixture = await launcherFixture();
      const child = spawn(
        process.execPath,
        ["run", "scripts/local.ts", "setup"],
        {
          cwd: fixture.directory,
          env: {
            PATH: dirname(process.execPath),
            CAPTURE: fixture.capture,
            HOLD_SYNC: hold,
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      const ready = join(fixture.directory, "ready");
      let pids: number[] = [];
      try {
        await until(async () => Bun.file(ready).exists());
        pids = JSON.parse(await readFile(ready, "utf8"));
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
        expect(await exited).toBe(signal === "SIGINT" ? 130 : 143);
        await until(async () => pids.every((pid: number) => !alive(pid)));
        expect((await fixture.calls()).map((call) => call.kind)).toEqual([
          "sync",
        ]);
      } finally {
        for (const pid of pids.reverse()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
      }
    }, 15000);
  }
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "arc-local-"));
  directories.push(directory);
  return directory;
}

function dotenv(env: Record<string, string>) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}

async function launcherFixture() {
  const directory = await temporary();
  const capture = join(directory, "calls.jsonl");
  await mkdir(join(directory, "scripts"), { recursive: true });
  await mkdir(join(directory, "apps/bot/src"), { recursive: true });
  await mkdir(join(directory, "node_modules/alchemy/bin"), { recursive: true });
  await symlink(
    join(root, "node_modules/effect"),
    join(directory, "node_modules/effect"),
  );
  await writeFile(
    join(directory, "apps/bot/src/config.js"),
    `export { publicOrigin, runtimeConfig } from ${JSON.stringify(join(root, "apps/bot/src/config.ts"))};`,
  );
  await copyFile(
    join(root, "scripts/local.ts"),
    join(directory, "scripts/local.ts"),
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", scripts: pkg.scripts }),
  );
  await writeFile(join(directory, ".env.local"), dotenv(fixtureEnv));
  const child = `
import { appendFile } from 'node:fs/promises';
const kind = import.meta.path.includes('sync-discord') ? 'sync' : import.meta.path.includes('ops.ts') ? 'ops' : 'dev';
await appendFile(process.env.CAPTURE, JSON.stringify({ kind, args: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath, env: Object.fromEntries(${JSON.stringify(Object.keys(fixtureEnv))}.map(key => [key, process.env[key]])) }) + '\\n');
if (kind === 'sync' && process.env.FAIL_SYNC) process.exit(Number(process.env.FAIL_SYNC));
if (kind === 'sync' && process.env.HOLD_SYNC) {
  const grandchild = Bun.spawn([process.execPath, '--no-env-file', '-e', "console.log('ready'); setInterval(() => {}, 1000);"], { stdout: 'pipe', stderr: 'ignore' });
  await grandchild.stdout.getReader().read();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { grandchild.exited.then(() => { if (process.env.HOLD_SYNC !== 'stubborn') process.exit(0); }); });
  await Bun.write('ready', JSON.stringify([process.pid, grandchild.pid]));
  setInterval(() => {}, 1000);
} else if (kind === 'ops' && process.argv[2] === 'setup') console.info('fixture-private-oauth-link');
`;
  for (const path of [
    "scripts/ops.ts",
    "scripts/sync-discord-commands.ts",
    "node_modules/alchemy/bin/cli.js",
  ])
    await writeFile(join(directory, path), child);
  return {
    directory,
    capture,
    async run(action: string | string[], env: NodeJS.ProcessEnv = {}) {
      const args =
        typeof action === "string"
          ? ["run", action]
          : ["run", "scripts/local.ts", ...action];
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: directory,
        env: { PATH: dirname(process.execPath), CAPTURE: capture, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output: stdout + stderr.replace(/^\$ .*\n/gm, "") };
    },
    async calls(): Promise<
      {
        kind: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
        execPath: string;
      }[]
    > {
      if (!(await Bun.file(capture).exists())) return [];
      return (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Local child did not reach the expected state");
    await Bun.sleep(10);
  }
}
