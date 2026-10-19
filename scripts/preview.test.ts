import { afterEach, describe, expect, test } from "bun:test";
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
import { Schema } from "effect";
import { CloudSettings, syntheticEnvironment } from "./cloud-settings.js";
import { type PreviewOperations, reconcilePreview } from "./preview.js";
import {
  CheckedPreview,
  PreviewStage,
  PullRequest,
  previewAction,
  previewDecision,
  previewIdentity,
} from "./preview-identity.js";

const preview = previewIdentity({
  repository: "PlagueFPS/arc-tools",
  number: 10,
});
const checked = Schema.decodeUnknownSync(CheckedPreview)({
  revision: "a".repeat(40),
  head: "b".repeat(40),
});
const pr = (
  state = "open",
  head: string = checked.head,
  merge: string | null = checked.revision,
) =>
  Schema.decodeUnknownSync(PullRequest)({
    state,
    head: { sha: head, repo: { full_name: preview.repository } },
    base: { repo: { full_name: preview.repository } },
    merge_commit_sha: merge,
  });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture(states: PullRequest[]) {
  const calls: string[] = [];
  const publications: string[] = [];
  const operations: PreviewOperations = {
    readPr: async () => {
      calls.push("read");
      const value = states.shift();
      if (!value) throw new Error("Missing PR observation");
      return value;
    },
    deploy: async (origin) => {
      calls.push(`deploy:${origin}`);
      return { stage: preview.stage, url: "https://fixture.invalid" };
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    health: async () => {
      calls.push("health");
    },
    publish: async (body) => {
      publications.push(body);
    },
  };
  return { calls, publications, operations };
}

describe("preview identity and boundaries", () => {
  test("one repository and PR own one stage across pushes, reopening, and checkout paths", () => {
    expect(
      previewIdentity({ repository: preview.repository, number: 10 }),
    ).toEqual(preview);
    expect(preview.stage).toMatch(/^test-tenant-[a-f0-9]{8}-[a-f0-9]{12}$/);
    expect(preview.stage.endsWith(`-${preview.run}`)).toBeTrue();
    expect(
      new Set(
        Array.from(
          { length: 200 },
          (_, index) =>
            previewIdentity({
              repository: preview.repository,
              number: index + 1,
            }).stage,
        ),
      ).size,
    ).toBe(200);
    for (const number of [0, -1, 1.5, NaN, Infinity, "10"])
      expect(() =>
        previewIdentity({ repository: preview.repository, number }),
      ).toThrow();
    expect(() =>
      previewIdentity({ repository: "fork/arc-tools", number: 10 }),
    ).toThrow();
  });
  test("cleanup has no arbitrary stage argument", () => {
    for (const target of [
      "prod",
      "staging",
      "local-me",
      "pr-10",
      "test-account-0123abcd-0123456789ab",
      "test-tenant-1-0123456789ab",
    ])
      expect(() => Schema.decodeUnknownSync(PreviewStage)(target)).toThrow();
    for (const args of [
      ["cleanup", "--stage", "prod"],
      ["cleanup", "--pr", "10", "prod"],
      ["cleanup", "--pr", "-1"],
      ["deploy", "--pr", "01"],
    ])
      expect(() => previewAction(args)).toThrow();
    expect(previewAction(["cleanup", "--pr", "10"])).toMatchObject({
      action: "cleanup",
      number: 10,
    });
  });
  test("unknown or abbreviated revisions and untrusted PR origins fail", () => {
    for (const revision of [
      "a".repeat(7),
      "A".repeat(40),
      "refs/heads/main",
      "",
    ])
      expect(() =>
        Schema.decodeUnknownSync(CheckedPreview)({
          revision,
          head: checked.head,
        }),
      ).toThrow();
    const fork = pr();
    expect(() =>
      previewDecision(
        { ...fork, head: { ...fork.head, repo: { full_name: "fork/repo" } } },
        checked,
      ),
    ).toThrow("Fork");
    expect(previewDecision(pr("open", checked.head, null), checked)).toBe(
      "stale",
    );
  });
  test("all inherited bot values are removed before explicit synthetic values and checked SHA", () => {
    const settings = Schema.decodeUnknownSync(CloudSettings)({
      ...preview,
      profile: "fixture",
    });
    const env = syntheticEnvironment(
      {
        TWITCH_CLIENT_SECRET: "PROD",
        TWITCH_UNKNOWN: "PROD",
        DISCORD_BOT_TOKEN: "PROD",
        DISCORD_EXTRA: "PROD",
        ARC_PUBLIC_URL: "https://prod.invalid",
        ARC_BUILD_REVISION: "PROD",
        ARC_UNKNOWN: "PROD",
        OPERATOR_SECRET: "PROD",
        OPERATOR_OTHER: "PROD",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        APPLICATION_STAGE: "prod",
      },
      settings,
    );
    expect(Object.values(env)).not.toContain("PROD");
    expect(env.ARC_PUBLIC_URL).toBeUndefined();
    expect(env.ARC_BUILD_REVISION).toBeUndefined();
    expect(env.ARC_STAGE).toBe(preview.stage);
    expect(env.APPLICATION_STAGE).toBe(preview.stage);
    expect(env.TWITCH_CLIENT_SECRET).toBe("fixture-secret");
    expect(env.DISCORD_BOT_TOKEN).toBe("fixture-token");
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("test-account");
  });
});

describe("resident preview reconciliation", () => {
  test("obtains the exact output URL, redeploys an explicit origin, verifies health, and records both SHAs", async () => {
    const f = fixture([pr(), pr(), pr(), pr()]);
    expect(
      await reconcilePreview(
        { action: "deploy", preview, checked },
        f.operations,
      ),
    ).toBe("deployed");
    expect(f.calls).toEqual([
      "read",
      "deploy:",
      "read",
      "deploy:https://fixture.invalid",
      "read",
      "health",
      "read",
    ]);
    expect(f.publications.at(-1)).toContain("https://fixture.invalid");
    expect(f.publications.at(-1)).toContain(checked.revision);
    expect(f.publications.at(-1)).toContain(checked.head);
  });
  for (const states of [
    [pr("closed")],
    [pr(), pr("closed")],
    [pr(), pr(), pr("closed")],
    [pr(), pr(), pr(), pr("closed")],
  ]) {
    test(`closure at observation ${states.length} destroys instead of publishing a URL`, async () => {
      const f = fixture([...states]);
      expect(
        await reconcilePreview(
          { action: "deploy", preview, checked },
          f.operations,
        ),
      ).toBe("destroyed");
      expect(f.calls.at(-1)).toBe("cleanup");
      expect(
        f.publications.some((body) => body.includes("https://")),
      ).toBeFalse();
    });
  }
  for (const states of [
    [pr("open", "c".repeat(40))],
    [pr(), pr("open", "c".repeat(40))],
    [pr(), pr(), pr("open", checked.head, "d".repeat(40))],
    [pr(), pr(), pr(), pr("open", "c".repeat(40))],
  ]) {
    test(`a stale head or merge at observation ${states.length} never publishes its URL`, async () => {
      const f = fixture([...states]);
      expect(
        await reconcilePreview(
          { action: "deploy", preview, checked },
          f.operations,
        ),
      ).toBe("stale");
      expect(
        f.publications.some((body) => body.includes("https://")),
      ).toBeFalse();
    });
  }
  test("repeat cleanup is repeatable, API failure prevents mutation, cleanup failure never claims success", async () => {
    const f = fixture([pr("closed"), pr("closed")]);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await reconcilePreview({ action: "cleanup", preview }, f.operations),
      ).toBe("destroyed");
    expect(f.calls.filter((call) => call === "cleanup")).toHaveLength(2);
    const open = fixture([pr()]);
    await expect(
      reconcilePreview({ action: "cleanup", preview }, open.operations),
    ).rejects.toThrow("closed PR");
    expect(open.calls).toEqual(["read"]);
    const failed = fixture([pr("closed")]);
    failed.operations.cleanup = async () => {
      throw new Error("strict cleanup failed");
    };
    await expect(
      reconcilePreview({ action: "cleanup", preview }, failed.operations),
    ).rejects.toThrow("strict cleanup failed");
    expect(failed.publications).toEqual([]);
    const unavailable = fixture([]);
    await expect(
      reconcilePreview(
        { action: "deploy", preview, checked },
        unavailable.operations,
      ),
    ).rejects.toThrow();
    expect(unavailable.calls).toEqual(["read"]);
  });
  test("failed health and changing output origin cannot publish success", async () => {
    const f = fixture([pr(), pr(), pr()]);
    f.operations.health = async () => {
      throw new Error("wrong revision");
    };
    await expect(
      reconcilePreview({ action: "deploy", preview, checked }, f.operations),
    ).rejects.toThrow("wrong revision");
    expect(
      f.publications.some((body) => body.includes("https://")),
    ).toBeFalse();
    const changing = fixture([pr(), pr()]);
    changing.operations.deploy = async (origin) => ({
      stage: preview.stage,
      url: origin ? "https://changed.invalid" : "https://fixture.invalid",
    });
    await expect(
      reconcilePreview(
        { action: "deploy", preview, checked },
        changing.operations,
      ),
    ).rejects.toThrow("origin changed");
  });
});

async function launcher() {
  const directory = await mkdtemp(join(tmpdir(), "arc-preview-"));
  directories.push(directory);
  for (const path of ["scripts", "node_modules", "apps/bot/src"])
    await mkdir(join(directory, path), { recursive: true });
  await symlink(
    new URL("../node_modules/effect", import.meta.url).pathname,
    join(directory, "node_modules/effect"),
  );
  for (const name of ["preview.ts", "preview-identity.ts", "cloud-settings.ts"])
    await copyFile(
      new URL(name, import.meta.url),
      join(directory, "scripts", name),
    );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(directory, "apps/bot/src/config.js"),
    `import { Schema } from 'effect'; export const TestStage = Schema.String.check(Schema.isPattern(/^test-[a-z0-9-]{1,24}-[a-f0-9]{12}$/));`,
  );
  await writeFile(
    join(directory, ".env"),
    "ARC_PUBLIC_URL=https://CANARY.invalid\nTWITCH_CLIENT_SECRET=CANARY\n",
  );
  await writeFile(
    join(directory, "scripts/preview-cloud.ts"),
    `
import { appendFile } from 'node:fs/promises';
const journal = await Bun.file('run.json').json();
if (journal.stage !== process.env.ARC_STAGE || journal.run !== process.env.ARC_CLOUD_RUN || journal.profile !== process.env.ALCHEMY_PROFILE) process.exit(14);
if (await Bun.file('.env').exists()) process.exit(15);
await appendFile(process.env.CAPTURE, JSON.stringify({ type: 'deploy', cwd: process.cwd(), env: process.env }) + '\\n');
if (process.env.FAIL_DEPLOY) process.exit(24);
await Bun.write('preview-output.json', JSON.stringify({ stage: journal.stage, url: 'https://fixture.invalid' }));
`,
  );
  await writeFile(
    join(directory, "scripts/cloud-cleanup.ts"),
    `
import { appendFile } from 'node:fs/promises';
const journal = await Bun.file('run.json').json();
if (journal.stage !== process.env.ARC_STAGE || journal.run !== process.env.ARC_CLOUD_RUN) process.exit(16);
await appendFile(process.env.CAPTURE, JSON.stringify({ type: 'cleanup', journal }) + '\\n');
if (process.env.FAIL_CLEANUP) process.exit(25);
`,
  );
  await writeFile(
    join(directory, "mock-api.ts"),
    `
import { appendFile } from 'node:fs/promises';
import { previewIdentity } from './scripts/preview-identity.ts';
const preview = previewIdentity({ repository: 'PlagueFPS/arc-tools', number: 10 });
globalThis.fetch = async (input, init) => {
 const url = String(input);
 if (url === 'https://fixture.invalid/health') return Response.json({status: 'ready', stage: preview.stage, revision: process.env.PREVIEW_REVISION});
 if (!url.startsWith('https://api.github.com/repos/PlagueFPS/arc-tools/')) throw new Error('Unexpected network access');
 if (url.endsWith('/pulls/10')) return Response.json({state: process.env.PR_STATE || 'open', head: {sha: process.env.PREVIEW_HEAD_SHA, repo: {full_name: preview.repository}}, base: {repo: {full_name: preview.repository}}, merge_commit_sha: process.env.PREVIEW_REVISION});
 if (init?.method === 'GET') return Response.json([{id: 123, body: '<!-- arc-tools-synthetic-preview -->', user: {login: 'github-actions[bot]'}}]);
 await appendFile(process.env.CAPTURE, JSON.stringify({type: 'comment', url, method: init.method, body: JSON.parse(init.body).body}) + '\\n');
 return Response.json({id: 123});
};
`,
  );
  return {
    directory,
    async run(action: string, extra: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--preload",
          join(directory, "mock-api.ts"),
          join(directory, "scripts/preview.ts"),
          action,
          "--pr",
          "10",
        ],
        {
          cwd: directory,
          env: {
            PATH: dirname(process.execPath),
            CAPTURE: join(directory, "calls"),
            PREVIEW_REVISION: checked.revision,
            PREVIEW_HEAD_SHA: checked.head,
            GITHUB_REPOSITORY: preview.repository,
            GITHUB_TOKEN: "fixture-github",
            CLOUDFLARE_ACCOUNT_ID: "fixture-account",
            CLOUDFLARE_API_TOKEN: "fixture-cloud",
            TWITCH_UNKNOWN: "CANARY",
            ARC_PUBLIC_URL: "https://CANARY.invalid",
            DISCORD_BOT_TOKEN: "CANARY",
            OPERATOR_EXTRA: "CANARY",
            ...extra,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output: stdout + stderr };
    },
    async calls() {
      return (await readFile(join(directory, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    journal(name: string) {
      return Bun.file(
        join(directory, ".cloud-tests", preview.stage, name),
      ).json();
    },
  };
}

test("real controller CLI writes recovery before children, strips secrets, redeploys exact URL, and updates the existing marked comment", async () => {
  const f = await launcher();
  const result = await f.run("deploy");
  expect(result).toMatchObject({ code: 0 });

  const calls = await f.calls();
  const deployments = calls.filter((call) => call.type === "deploy");
  expect(deployments).toHaveLength(2);
  expect(deployments.map((call) => call.env.ARC_PUBLIC_URL)).toEqual([
    "",
    "https://fixture.invalid",
  ]);
  for (const call of deployments) {
    expect(call.env.ARC_BUILD_REVISION).toBe(checked.revision);
    expect(call.env.TWITCH_UNKNOWN).toBeUndefined();
    expect(call.env.OPERATOR_EXTRA).toBeUndefined();
    expect(call.env.DISCORD_BOT_TOKEN).toBe("fixture-token");
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
  }
  expect(
    calls
      .filter((call) => call.type === "comment")
      .every(
        (call) =>
          call.method === "PATCH" && call.url.endsWith("/issues/comments/123"),
      ),
  ).toBeTrue();
  expect(await f.journal("run.json")).toMatchObject({
    stage: preview.stage,
    run: preview.run,
    profile: "default",
    revision: checked.revision,
    head: checked.head,
  });
  expect(
    Schema.decodeUnknownSync(CloudSettings)(await f.journal("run.json")),
  ).toMatchObject({ stage: preview.stage, run: preview.run });
  expect(await f.journal("preview-result.json")).toMatchObject({
    result: "deployed",
  });
}, 15000);

test("closed cleanup works in a fresh checkout with no prior artifact, repeats, and retains failure evidence", async () => {
  const f = await launcher();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run("cleanup", { PR_STATE: "closed" });
    expect(result.code).toBe(0);
  }
  expect(
    (await f.calls()).filter((call) => call.type === "cleanup"),
  ).toHaveLength(2);
  expect(
    (await f.run("cleanup", { PR_STATE: "closed", FAIL_CLEANUP: "1" })).code,
  ).toBe(1);
  expect(await f.journal("preview-result.json")).toMatchObject({
    result: "failed",
    action: "cleanup",
  });
  expect(await f.journal("run.json")).toMatchObject({
    stage: preview.stage,
    run: preview.run,
  });
  const before = (await f.calls()).filter(
    (call) => call.type === "comment",
  ).length;
  expect((await f.run("deploy", { FAIL_DEPLOY: "1" })).code).toBe(1);
  expect(
    (await f.calls()).filter((call) => call.type === "comment"),
  ).toHaveLength(before + 1);
  expect(await f.journal("preview-result.json")).toMatchObject({
    result: "failed",
    action: "deploy",
  });
  expect(
    await Bun.file(
      join(f.directory, ".cloud-tests", preview.stage, "preview-output.json"),
    ).exists(),
  ).toBeFalse();
  expect((await f.run("cleanup", { PR_STATE: "closed" })).code).toBe(0);
  expect(await f.journal("preview-result.json")).toMatchObject({
    result: "destroyed",
    action: "cleanup",
  });
}, 15000);
