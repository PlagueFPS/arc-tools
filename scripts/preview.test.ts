/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
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

import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Match,
  Schema,
  Redacted,
  Array as Arr,
  Record as Rec,
  String as Str,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { CloudSettings, syntheticEnvironment } from "./cloud-settings.js";
import { makePreviewHttp } from "./preview-http.js";
import {
  CheckedPreview,
  PreviewStage,
  PullRequest,
  previewAction,
  previewDecision,
  previewIdentity,
} from "./preview-identity.js";
import { type PreviewOperations, reconcilePreview } from "./preview.js";

const preview = previewIdentity({
  repository: "PlagueFPS/arc-tools",
  number: 10,
});

const checked = Schema.decodeSync(CheckedPreview)({
  revision: Str.repeat(40)("a"),
  head: Str.repeat(40)("b"),
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
    Arr.map(directories.splice(0), (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
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
    expect(Str.endsWith(`-${preview.run}`)(preview.stage)).toBeTrue();
    expect(
      Arr.dedupe(
        Array.from(
          { length: 200 },
          (_, index) =>
            previewIdentity({
              repository: preview.repository,
              number: index + 1,
            }).stage,
        ),
      ).length,
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
      expect(() => Schema.decodeSync(PreviewStage)(target)).toThrow();

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
      Str.repeat(7)("a"),
      Str.repeat(40)("A"),
      "refs/heads/main",
      "",
    ])
      expect(() =>
        Schema.decodeSync(CheckedPreview)({
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
    const settings = Schema.decodeSync(CloudSettings)({
      ...preview,
      profile: "fixture",
    });

    const env = syntheticEnvironment(
      {
        TWITCH_CLIENT_SECRET: "PROD",
        TWITCH_UNKNOWN: "PROD",
        DISCORD_BOT_TOKEN: "PROD",
        DISCORD_EXTRA: "PROD",
        ARC_BOT_URL: "https://prod.invalid",
        ARC_BUILD_REVISION: "PROD",
        ARC_UNKNOWN: "PROD",
        OPERATOR_SECRET: "PROD",
        OPERATOR_OTHER: "PROD",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        APPLICATION_STAGE: "prod",
      },
      settings,
    );

    expect(Rec.values(env)).not.toContain("PROD");
    expect(env.ARC_BOT_URL).toBeUndefined();
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
        Arr.some(f.publications, (body) => !!Str.includes("https://")(body)),
      ).toBeFalse();
    });
  }

  for (const states of [
    [pr("open", Str.repeat(40)("c"))],
    [pr(), pr("open", Str.repeat(40)("c"))],
    [pr(), pr(), pr("open", checked.head, Str.repeat(40)("d"))],
    [pr(), pr(), pr(), pr("open", Str.repeat(40)("c"))],
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
        Arr.some(f.publications, (body) => !!Str.includes("https://")(body)),
      ).toBeFalse();
    });
  }

  test("repeat cleanup is repeatable, API failure prevents mutation, cleanup failure never claims success", async () => {
    const f = fixture([pr("closed"), pr("closed")]);

    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await reconcilePreview({ action: "cleanup", preview }, f.operations),
      ).toBe("destroyed");
    expect(Arr.filter(f.calls, (call) => !!(call === "cleanup"))).toHaveLength(
      2,
    );
    const open = fixture([pr()]);
    expect(
      reconcilePreview({ action: "cleanup", preview }, open.operations),
    ).rejects.toThrow("closed PR");
    expect(open.calls).toEqual(["read"]);
    const failed = fixture([pr("closed")]);
    failed.operations.cleanup = async () => {
      throw new Error("strict cleanup failed");
    };

    expect(
      reconcilePreview({ action: "cleanup", preview }, failed.operations),
    ).rejects.toThrow("strict cleanup failed");
    expect(failed.publications).toEqual([]);
    const unavailable = fixture([]);
    expect(
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

    expect(
      reconcilePreview({ action: "deploy", preview, checked }, f.operations),
    ).rejects.toThrow("wrong revision");
    expect(
      Arr.some(f.publications, (body) => !!Str.includes("https://")(body)),
    ).toBeFalse();
    const changing = fixture([pr(), pr()]);
    changing.operations.deploy = async (origin) => ({
      stage: preview.stage,
      url: origin ? "https://changed.invalid" : "https://fixture.invalid",
    });
    expect(
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

  for (const name of [
    "preview.ts",
    "preview-http.ts",
    "preview-identity.ts",
    "cloud-settings.ts",
  ])
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
    "ARC_BOT_URL=https://CANARY.invalid\nTWITCH_CLIENT_SECRET=CANARY\n",
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
            ARC_BOT_URL: "https://CANARY.invalid",
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
      return Arr.map(
        Str.split(
          Str.trim(await readFile(join(directory, "calls"), "utf8")),
          "\n",
        ),
        (line) => JSON.parse(line),
      );
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

  const deployments = Arr.filter(calls, (call) => !!(call.type === "deploy"));

  expect(deployments).toHaveLength(2);
  expect(Arr.map(deployments, (call) => call.env.ARC_BOT_URL)).toEqual([
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
    Arr.every(
      Arr.filter(calls, (call) => !!(call.type === "comment")),
      (call) =>
        !!(
          call.method === "PATCH" && call.url.endsWith("/issues/comments/123")
        ),
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
    Arr.filter(await f.calls(), (call) => !!(call.type === "cleanup")),
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

  const before = Arr.filter(
    await f.calls(),
    (call) => !!(call.type === "comment"),
  ).length;

  expect((await f.run("deploy", { FAIL_DEPLOY: "1" })).code).toBe(1);
  expect(
    Arr.filter(await f.calls(), (call) => !!(call.type === "comment")),
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

const makeHttp = (origin: string) =>
  Effect.runPromise(
    makePreviewHttp({
      preview,
      token: Redacted.make("fixture-github"),
      githubOrigin: origin,
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "follow",
      }),
    ),
  );

const fastPollingClock = Effect.fnUntraced(function* (sleeps: number[]) {
  const clock = yield* Clock.clockWith(Effect.succeed);

  return {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration: Duration.Duration) => {
      const millis = Duration.toMillis(duration);
      sleeps.push(millis);

      return millis < 10_000 ? Effect.void : Effect.never;
    },
  } satisfies Clock.Clock;
});

describe("native preview HTTP boundary", () => {
  for (const existing of [false, true]) {
    test(`GitHub ${existing ? "PATCH" : "POST"} preserves auth, body, pagination, and PR decoding`, async () => {
      const requests: Array<{
        method: string;
        path: string;
        headers: Headers;
        body: string;
      }> = [];

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path =
            new URL(request.url).pathname + new URL(request.url).search;

          requests.push({
            method: request.method,
            path,
            headers: request.headers,
            body: await request.text(),
          });

          if (Str.endsWith("/pulls/10")(path)) return Response.json(pr());

          if (request.method !== "GET") return Response.json({ id: 123 });

          if (existing && Str.endsWith("page=1")(path))
            return Response.json(
              Array.from({ length: 100 }, (_, id) => ({
                id: id + 1,
                body: "unrelated",
                user: { login: "github-actions[bot]" },
              })),
            );

          return Response.json(
            existing
              ? [
                  {
                    id: 123,
                    body: "<!-- arc-tools-synthetic-preview -->",
                    user: { login: "github-actions[bot]" },
                  },
                ]
              : [],
          );
        },
      });

      try {
        const http = await makeHttp(server.url.origin);
        expect(await Effect.runPromise(http.readPr())).toEqual(pr());
        await Effect.runPromise(http.publish("deployment result"));
        expect(
          Arr.map(requests, ({ method, path }) => `${method} ${path}`),
        ).toEqual([
          "GET /repos/PlagueFPS/arc-tools/pulls/10",
          "GET /repos/PlagueFPS/arc-tools/issues/10/comments?per_page=100&page=1",
          ...(existing
            ? [
                "GET /repos/PlagueFPS/arc-tools/issues/10/comments?per_page=100&page=2",
              ]
            : []),
          existing
            ? "PATCH /repos/PlagueFPS/arc-tools/issues/comments/123"
            : "POST /repos/PlagueFPS/arc-tools/issues/10/comments",
        ]);

        for (const request of requests) {
          expect(request.headers.get("authorization")).toBe(
            "Bearer fixture-github",
          );
          expect(request.headers.get("accept")).toBe(
            "application/vnd.github+json",
          );
          expect(request.headers.get("x-github-api-version")).toBe(
            "2022-11-28",
          );
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(request.body).toBe(
            request.method === "GET"
              ? ""
              : JSON.stringify({
                  body: "<!-- arc-tools-synthetic-preview -->\ndeployment result",
                }),
          );
        }
      } finally {
        await server.stop(true);
      }
    });
  }

  test("GitHub status diagnostics omit response bodies and invalid schemas or JSON fail", async () => {
    let response = new Response("private response", { status: 503 });
    let calls = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++;

        return response;
      },
    });

    try {
      const http = await makeHttp(server.url.origin);
      const failed = await Effect.runPromiseExit(http.readPr());
      expect(Exit.isFailure(failed)).toBeTrue();

      if (Exit.isFailure(failed)) {
        const diagnostic = Cause.pretty(failed.cause);
        expect(diagnostic).toContain("GitHub GET pulls/10: HTTP 503");
        expect(diagnostic).not.toContain("private response");
        expect(diagnostic).not.toContain("fixture-github");
      }

      for (const invalid of [
        Response.json({ state: "open" }),
        new Response("not json"),
        new Response(""),
      ]) {
        response = invalid;
        expect(Effect.runPromise(http.readPr())).rejects.toThrow();
      }

      expect(calls).toBe(4);
    } finally {
      await server.stop(true);
    }
  });

  for (const existing of [false, true]) {
    test(`failed GitHub ${existing ? "PATCH" : "POST"} is never retried`, async () => {
      let mutations = 0;

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (request.method === "GET")
            return Response.json(
              existing
                ? [
                    {
                      id: 123,
                      body: "<!-- arc-tools-synthetic-preview -->",
                      user: { login: "github-actions[bot]" },
                    },
                  ]
                : [],
            );
          mutations++;

          return new Response("private provider failure", { status: 503 });
        },
      });

      try {
        const http = await makeHttp(server.url.origin);
        expect(Effect.runPromise(http.publish("result"))).rejects.toThrow(
          existing
            ? "GitHub PATCH issues/comments/123: HTTP 503"
            : "GitHub POST issues/10/comments: HTTP 503",
        );
        expect(mutations).toBe(1);
      } finally {
        await server.stop(true);
      }
    });
  }

  test("health recovers through status, JSON, schema, stage, and exact revision failures without GitHub credentials", async () => {
    const sleeps: number[] = [];

    const responses = [
      new Response("unhealthy", { status: 503 }),
      new Response("not json"),
      Response.json({ status: "starting" }),
      Response.json({
        status: "ready",
        stage: previewIdentity({ repository: preview.repository, number: 11 })
          .stage,
        revision: checked.revision,
      }),
      Response.json({
        status: "ready",
        stage: preview.stage,
        revision: checked.head,
      }),
      Response.json({
        status: "ready",
        stage: preview.stage,
        revision: checked.revision,
      }),
    ];

    const requests: Array<{ path: string; authorized: boolean }> = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorized: request.headers.has("authorization"),
        });

        return (
          responses.shift() ??
          new Response("excess health call", { status: 500 })
        );
      },
    });

    try {
      const http = await makeHttp(server.url.origin);
      const clock = await Effect.runPromise(fastPollingClock(sleeps));
      await Effect.runPromise(
        http
          .health(server.url.origin, checked)
          .pipe(Effect.provideService(Clock.Clock, clock)),
      );
      expect(requests).toHaveLength(6);
      expect(Arr.filter(sleeps, (millis) => !!(millis < 10_000))).toEqual(
        Array(5).fill(1000),
      );
      expect(Arr.filter(sleeps, (millis) => !!(millis >= 10_000))).toEqual(
        Array(6).fill(10_000),
      );
      expect(
        Arr.every(
          requests,
          (request) => !!(request.path === "/health" && !request.authorized),
        ),
      ).toBeTrue();
    } finally {
      await server.stop(true);
    }
  });

  test("health follows redirects and accepts large schema-valid responses", async () => {
    const paths: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);

        return path === "/health"
          ? new Response(null, { status: 302, headers: { location: "/ready" } })
          : Response.json({
              status: "ready",
              stage: preview.stage,
              revision: checked.revision,
              padding: Str.repeat(2 * 1024 * 1024)("x"),
            });
      },
    });

    try {
      const http = await makeHttp(server.url.origin);
      await Effect.runPromise(http.health(server.url.origin, checked));
      expect(paths).toEqual(["/health", "/ready"]);
    } finally {
      await server.stop(true);
    }
  });

  for (const mismatch of ["stage", "revision"]) {
    test(`health rejects an exact ${mismatch} mismatch after 60 attempts and only 59 gaps`, async () => {
      let calls = 0;
      const sleeps: number[] = [];

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          calls++;

          return Response.json({
            status: "ready",
            stage:
              mismatch === "stage"
                ? previewIdentity({
                    repository: preview.repository,
                    number: 11,
                  }).stage
                : preview.stage,
            revision: mismatch === "revision" ? checked.head : checked.revision,
          });
        },
      });

      try {
        const http = await makeHttp(server.url.origin);
        const clock = await Effect.runPromise(fastPollingClock(sleeps));
        expect(
          Effect.runPromise(
            http
              .health(server.url.origin, checked)
              .pipe(Effect.provideService(Clock.Clock, clock)),
          ),
        ).rejects.toThrow(
          "Preview health did not match the exact stage and checked merge revision",
        );
        expect(calls).toBe(60);
        expect(Arr.filter(sleeps, (millis) => !!(millis < 10_000))).toEqual(
          Array(59).fill(1000),
        );
        expect(Arr.filter(sleeps, (millis) => !!(millis >= 10_000))).toEqual(
          Array(60).fill(10_000),
        );
      } finally {
        await server.stop(true);
      }
    });
  }
});

for (const target of ["github", "health", "post", "patch"]) {
  test(`${target} timeout encloses body consumption and aborts the response before recovery`, async () => {
    const headers = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let calls = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (
          (target === "post" || target === "patch") &&
          request.method === "GET"
        )
          return Response.json(
            target === "patch"
              ? [
                  {
                    id: 123,
                    body: "<!-- arc-tools-synthetic-preview -->",
                    user: { login: "github-actions[bot]" },
                  },
                ]
              : [],
          );

        calls++;

        if (calls > 1)
          return Response.json({
            status: "ready",
            stage: preview.stage,
            revision: checked.revision,
          });
        request.signal.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":'));
            },
          }),
        );
      },
    });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          const transport = yield* HttpClient.HttpClient;

          const http = yield* makePreviewHttp({
            preview,
            token: Redacted.make("fixture-github"),
            githubOrigin: server.url.origin,
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              transport.pipe(
                HttpClient.tap((response) =>
                  (target === "post" || target === "patch") &&
                  response.request.method === "GET"
                    ? Effect.void
                    : Effect.sync(() => headers.resolve()),
                ),
              ),
            ),
          );

          const operation = Match.value(target).pipe(
            Match.when("github", () => http.readPr()),
            Match.when("health", () => http.health(server.url.origin, checked)),
            Match.orElse(() => http.publish("result")),
          );

          const fiber = yield* operation.pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.exit,
            Effect.forkChild,
          );

          yield* Effect.promise(() => headers.promise);
          const timeout = target === "health" ? 10_000 : 30_000;
          yield* clock.adjust(timeout - 1);
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(calls).toBe(1);
          yield* clock.adjust(1);
          yield* Effect.promise(() => aborted.promise);

          if (target === "health") {
            yield* clock.adjust(999);
            expect(calls).toBe(1);
            yield* clock.adjust(1);
          }

          const result = yield* Fiber.join(fiber);

          if (target !== "health") {
            expect(Exit.isFailure(result)).toBeTrue();

            if (Exit.isFailure(result))
              expect(Cause.pretty(result.cause)).toContain("TimeoutError");
            expect(calls).toBe(1);
          } else {
            expect(Exit.isSuccess(result)).toBeTrue();
            expect(calls).toBe(2);
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "follow",
          }),
        ),
      );
    } finally {
      await server.stop(true);
    }
  });
}

for (const target of ["github", "health"]) {
  test(`caller cancellation aborts the ${target} body without another attempt`, async () => {
    const headers = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let calls = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls++;
        request.signal.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":'));
            },
          }),
        );
      },
    });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* HttpClient.HttpClient;

          const http = yield* makePreviewHttp({
            preview,
            token: Redacted.make("fixture-github"),
            githubOrigin: server.url.origin,
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              transport.pipe(
                HttpClient.tap(() => Effect.sync(() => headers.resolve())),
              ),
            ),
          );

          const operation =
            target === "github"
              ? http.readPr()
              : http.health(server.url.origin, checked);

          const fiber = yield* operation.pipe(Effect.forkChild);
          yield* Effect.promise(() => headers.promise);
          yield* Fiber.interrupt(fiber);
          const result = yield* Fiber.await(fiber);
          yield* Effect.promise(() => aborted.promise);
          expect(Exit.isFailure(result)).toBeTrue();

          if (Exit.isFailure(result))
            expect(Cause.hasInterrupts(result.cause)).toBeTrue();
          expect(calls).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
      );
    } finally {
      await server.stop(true);
    }
  });
}

test("a rejected GitHub status aborts an unread streaming error body", async () => {
  const aborted = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("private unfinished response"),
            );
          },
        }),
        { status: 503 },
      );
    },
  });

  try {
    const http = await makeHttp(server.url.origin);
    expect(Effect.runPromise(http.readPr())).rejects.toThrow(
      "GitHub GET pulls/10: HTTP 503",
    );
    await aborted.promise;
  } finally {
    await server.stop(true);
  }
});
