import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

const expression = (value: string) => `\${{ ${value} }}`;

const Strings = Schema.Record(Schema.String, Schema.String);

const Step = Schema.Struct({
  name: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  env: Schema.optional(Strings),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const Job = Schema.Struct({
  needs: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  concurrency: Schema.optional(
    Schema.Struct({
      group: Schema.String,
      "cancel-in-progress": Schema.Boolean,
    }),
  ),
  permissions: Schema.optional(Strings),
  env: Schema.optional(Strings),
  with: Schema.optional(Strings),
  secrets: Schema.optional(Strings),
  steps: Schema.optional(Schema.Array(Step)),
});

const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  jobs: Schema.Record(Schema.String, Job),
});

async function load(name: string) {
  return Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(
      await Bun.file(
        new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      ).text(),
    ),
  );
}

const ci = await load("ci");

const release = await load("release");

const cleanup = await load("preview-cleanup");

function job(workflow: typeof Workflow.Type, name: string) {
  const value = workflow.jobs[name];

  if (!value) throw new Error(`Missing job ${name}`);

  return value;
}

function step(workflow: typeof Workflow.Type, jobName: string, name: string) {
  const value = job(workflow, jobName).steps?.find(
    (step) => step.name === name,
  );

  if (!value) throw new Error(`Missing step ${name}`);

  return value;
}

const trigger = Schema.Struct({
  branches: Schema.Array(Schema.String),
  types: Schema.Array(Schema.String),
});

function enabled(
  expression: string | undefined,
  github: GithubContext,
  inputs: { stage?: string } = {},
) {
  if (!expression) return true;

  return (
    new Function("github", "inputs", `return (${expression});`)(
      github,
      inputs,
    ) === true
  );
}

interface GithubContext {
  readonly event_name: string;
  readonly repository: string;
  readonly ref: string;
  readonly event: {
    readonly number?: number;
    readonly action: string;
    readonly pull_request: {
      readonly head: { readonly repo: { readonly full_name: string } };
    };
  };
}

function context(
  eventName: string,
  fork = false,
  action = "synchronize",
): GithubContext {
  return {
    event_name: eventName,
    repository: "PlagueFPS/arc-tools",
    ref: "refs/heads/main",
    event: {
      number: 10,
      action,
      pull_request: {
        head: {
          repo: { full_name: fork ? "fork/arc-tools" : "PlagueFPS/arc-tools" },
        },
      },
    },
  };
}

const revision = "a".repeat(40);

const app = "123456789";

const releaseSecretNames = [
  "TWITCH_CLIENT_SECRET",
  "TWITCH_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
  "OPERATOR_SECRET",
  "CLOUDFLARE_API_TOKEN",
] as const;

const fixtureSecrets = Object.fromEntries(
  releaseSecretNames.map((name) => [name, `fixture-${name}-credential`]),
);

const callableRelease = Schema.Struct({
  secrets: Schema.Record(
    Schema.String,
    Schema.Struct({ required: Schema.Boolean }),
  ),
});

function checkSecretForwarding(caller: typeof Job.Type) {
  for (const name of releaseSecretNames) {
    if (caller.secrets?.[name] !== expression(`secrets.${name}`))
      throw new Error(`Release caller must forward ${name} by name`);
  }
}

const guard = step(
  release,
  "release",
  "Guard release origin and identity after acquiring the lock",
);

async function runGuard(
  overrides: Record<string, string | undefined> = {},
  eventName = "push",
  ref = "refs/heads/main",
  currentHead = revision,
  observed: { apiCalls: number; logs: string[] } = { apiCalls: 0, logs: [] },
) {
  const script = Schema.decodeUnknownSync(Schema.String)(guard.with?.script);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "process", "console", script)(
    {
      rest: {
        git: {
          getRef: async () => {
            observed.apiCalls++;

            return { data: { object: { sha: currentHead } } };
          },
        },
      },
    },
    {
      eventName,
      ref,
      sha: revision,
      repo: { owner: "PlagueFPS", repo: "arc-tools" },
    },
    {
      env: {
        ...fixtureSecrets,
        ARC_STAGE: "prod",
        ARC_BUILD_REVISION: revision,
        RELEASE_APPLICATION_ID: app,
        DISCORD_APPLICATION_ID: app,
        ARC_BOT_URL: "https://existing.invalid",
        ARC_WEBSITE_URL: "https://website.invalid",
        ...overrides,
      },
    },
    Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map((name) => [
        name,
        (...values: unknown[]) => observed.logs.push(values.join(" ")),
      ]),
    ),
  );
}

describe("workflow event and dependency behavior", () => {
  test("missing trusted cloud settings fail with actionable names without printing credentials", async () => {
    const command = step(ci, "ci", "Require trusted cloud configuration").run;

    if (!command) throw new Error("Missing cloud configuration command");

    for (const [account, token, code, message] of [
      ["", "CANARY", 1, "CLOUDFLARE_TEST_ACCOUNT_ID"],
      ["fixture-account", "", 1, "CLOUDFLARE_TEST_API_TOKEN"],
      ["fixture-account", "CANARY", 0, ""],
    ] as const) {
      const child = Bun.spawn(["/bin/bash", "-c", command], {
        env: { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [actual, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(actual).toBe(code);
      expect(stdout + stderr).toContain(message);
      expect(stdout + stderr).not.toContain("CANARY");
    }
  });
  test("PR checks and trusted target close events are separate and cleanup never depends on CI", () => {
    const checks = Schema.decodeUnknownSync(trigger)(ci.on.pull_request);
    expect(checks).toEqual({
      branches: ["main"],
      types: ["opened", "reopened", "synchronize"],
    });
    expect(
      Schema.decodeUnknownSync(trigger)(cleanup.on.pull_request_target),
    ).toEqual({ branches: ["main"], types: ["closed"] });
    expect(cleanup.on.pull_request).toBeUndefined();
    expect(job(cleanup, "cleanup").needs).toBeUndefined();

    for (const workflow of [ci, release])
      expect(workflow.on.pull_request_target).toBeUndefined();
    expect(job(ci, "preview").needs).toBe("ci");
    expect(job(ci, "release").needs).toBe("ci");
    expect(job(ci, "release").uses).toBe("./.github/workflows/release.yml");
  });
  test("automatic release explicitly forwards every required environment secret", () => {
    const caller = job(ci, "release");
    expect(() => checkSecretForwarding(caller)).not.toThrow();
    expect(Object.keys(caller.secrets ?? {}).sort()).toEqual(
      [...releaseSecretNames].sort(),
    );

    const called = Schema.decodeUnknownSync(callableRelease)(
      release.on.workflow_call,
    );

    expect(Object.keys(called.secrets).sort()).toEqual(
      [...releaseSecretNames].sort(),
    );

    for (const name of releaseSecretNames) {
      expect(called.secrets[name]?.required).toBeTrue();
      expect(job(release, "release").env?.[name]).toBe(
        expression(`secrets.${name}`),
      );
      const missing = { ...caller.secrets };
      delete missing[name];
      expect(() =>
        checkSecretForwarding({ ...caller, secrets: missing }),
      ).toThrow(name);
      expect(() =>
        checkSecretForwarding({
          ...caller,
          secrets: { ...caller.secrets, [name]: expression("secrets.OTHER") },
        }),
      ).toThrow(name);
    }
  });
  test("trusted push and PR checks require credentials; forks explicitly skip cloud and preview", () => {
    const credentialCheck = step(
      ci,
      "ci",
      "Require trusted cloud configuration",
    );

    const cloud = step(ci, "ci", "Real Cloudflare integration tests");

    for (const [
      eventName,
      fork,
      cloudExpected,
      previewExpected,
      releaseExpected,
    ] of [
      ["push", false, true, false, true],
      ["pull_request", false, true, true, false],
      ["pull_request", true, false, false, false],
    ] as const) {
      const github = context(eventName, fork);
      expect(enabled(credentialCheck.if, github)).toBe(cloudExpected);
      expect(enabled(cloud.if, github)).toBe(cloudExpected);
      expect(enabled(job(ci, "preview").if, github)).toBe(previewExpected);
      expect(enabled(job(ci, "release").if, github)).toBe(releaseExpected);
      expect(enabled(step(ci, "ci", "Explain fork isolation").if, github)).toBe(
        fork,
      );
    }

    for (const name of [
      "CLOUDFLARE_TEST_ACCOUNT_ID",
      "CLOUDFLARE_TEST_API_TOKEN",
    ])
      expect(credentialCheck.run).toContain(name);
    expect(cloud.run).toBe("bun --no-env-file run test:cloud");
    expect(step(ci, "ci", "Retry disposable Cloudflare cleanup").if).toContain(
      "always()",
    );
    expect(step(ci, "ci", "Preserve cleanup recovery identity").if).toContain(
      "always()",
    );

    for (const result of ["failure", "cancelled", "skipped"]) {
      for (const downstream of ["preview", "release"]) {
        const dependency = job(ci, downstream).needs;
        const outcomes = { ci: result };
        expect(dependency === "ci" && outcomes.ci === "success").toBeFalse();
      }
    }
  });
  test("close cleanup accepts conflicted or deleted same-repository heads and skips forks without checking out PR code", () => {
    const close = job(cleanup, "cleanup");

    const target = Schema.decodeUnknownSync(trigger)(
      cleanup.on.pull_request_target,
    );

    for (const [event, action, fork, merged, expected] of [
      ["pull_request_target", "closed", false, false, true],
      ["pull_request_target", "closed", false, true, true],
      ["pull_request_target", "closed", true, false, false],
      ["pull_request_target", "opened", false, false, false],
      ["pull_request_target", "synchronize", false, false, false],
      ["pull_request", "closed", false, false, false],
      ["push", "closed", false, false, false],
    ] as const) {
      const github = context(event, fork, action);

      const conflictedOrDeleted = {
        ...github,
        event: {
          ...github.event,
          pull_request: {
            ...github.event.pull_request,
            merged,
            mergeable: false,
            head: { ...github.event.pull_request.head, ref: undefined },
          },
        },
      };

      expect(
        event === "pull_request_target" &&
          target.types.includes(action) &&
          enabled(close.if, conflictedOrDeleted),
      ).toBe(expected);
    }

    expect(enabled(close.if, context("workflow_dispatch"))).toBeTrue();
    expect(Object.keys(cleanup.on).sort()).toEqual([
      "pull_request_target",
      "workflow_dispatch",
    ]);

    const checkouts = close.steps?.filter(
      (entry) => entry.uses === "actions/checkout@v4",
    );

    expect(checkouts?.length).toBe(1);
    expect(checkouts?.[0]?.with).toEqual({ ref: "main" });
    expect(close.env).toBeUndefined();

    for (const entry of close.steps ?? []) {
      if (entry.uses)
        expect([
          "actions/checkout@v4",
          "oven-sh/setup-bun@v2",
          "actions/upload-artifact@v4",
        ]).toContain(entry.uses);
      expect(entry.run ?? "").not.toContain("${{");

      for (const value of Object.values(entry.env ?? {}))
        if (value.includes("secrets."))
          expect([
            expression("secrets.GITHUB_TOKEN"),
            expression("secrets.CLOUDFLARE_TEST_API_TOKEN"),
          ]).toContain(value);
    }

    expect(close.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
  });
  test("preview deploy and cleanup share repository and PR locks, preserve recovery, and grant comment writes only to their jobs", () => {
    const deploy = job(ci, "preview");
    const close = job(cleanup, "cleanup");

    const expand = (value: string, github: GithubContext, inputs = {}) =>
      value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) =>
        String(
          new Function("github", "inputs", `return (${expression});`)(
            github,
            inputs,
          ),
        ),
      );

    expect(
      expand(deploy.concurrency?.group ?? "", context("pull_request")),
    ).toBe(
      expand(
        close.concurrency?.group ?? "",
        context("pull_request_target", false, "closed"),
      ),
    );
    const manual = context("workflow_dispatch");

    const manualContext = {
      ...manual,
      event: { ...manual.event, number: undefined },
    };

    expect(
      expand(close.concurrency?.group ?? "", manualContext, { pr: "10" }),
    ).toBe(expand(deploy.concurrency?.group ?? "", context("pull_request")));

    for (const value of [deploy, close]) {
      expect(value.concurrency?.["cancel-in-progress"]).toBeFalse();
      expect(value.permissions?.["pull-requests"]).toBe("write");
      expect(
        value.steps?.find((step) => step.uses === "actions/upload-artifact@v4")
          ?.if,
      ).toBe("always()");
    }

    expect(job(ci, "ci").permissions?.["pull-requests"]).toBeUndefined();
    expect(
      job(release, "release").permissions?.["pull-requests"],
    ).toBeUndefined();
    expect(
      step(cleanup, "cleanup", "Checkout trusted cleanup code").with?.ref,
    ).toBe("main");
    expect(
      step(cleanup, "cleanup", "Require installed cleanup implementation").run,
    ).toContain("No cleanup was performed");

    for (const workflow of [ci, cleanup])
      for (const value of Object.values(workflow.jobs))
        for (const entry of value.steps ?? []) {
          expect(entry.run ?? "").not.toContain("${{");
          expect(entry.env?.DISCORD_BOT_TOKEN).toBeUndefined();
          expect(entry.env?.TWITCH_CLIENT_SECRET).toBeUndefined();
        }
  });
  test("single release owner pins checkout and build identity, environment, application lock, and partial-failure summary", () => {
    expect(release.on.workflow_call).toBeDefined();
    expect(release.on.workflow_dispatch).toBeDefined();
    expect(release.on.push).toBeUndefined();
    const owner = job(release, "release");
    expect(owner.environment).toBe(expression("inputs.stage"));
    expect(owner.concurrency).toEqual({
      group: `arc-discord-${expression("inputs.application_id")}`,
      "cancel-in-progress": false,
    });
    expect(owner.env?.ARC_BUILD_REVISION).toBe(
      expression("inputs.revision || github.sha"),
    );
    expect(
      owner.steps?.find((entry) => entry.uses === "actions/checkout@v4")?.with
        ?.ref,
    ).toBe(owner.env?.ARC_BUILD_REVISION);
    expect(job(ci, "release").with).toEqual({
      stage: "prod",
      application_id: expression("vars.PROD_DISCORD_APPLICATION_ID"),
      revision: expression("github.sha"),
    });
    expect(step(release, "release", "Report partial release").if).toContain(
      "steps.deploy.outcome == 'success'",
    );
    expect(
      step(release, "release", "Synchronize this release's global commands")
        .run,
    ).toContain('--revision "$ARC_BUILD_REVISION" --wait');
    expect(
      step(release, "release", "Recheck main immediately before deployment").if,
    ).toBe("github.event_name == 'push'");
  });
});

describe("executed release origin and revision guard", () => {
  test("each empty release secret fails before API calls or dependency operations and never logs credentials", async () => {
    expect(job(release, "release").steps?.[0]).toEqual(guard);

    for (const event of ["push", "workflow_dispatch"]) {
      for (const name of releaseSecretNames) {
        for (const empty of ["", " \t"]) {
          const observed = { apiCalls: 0, logs: [] };
          await expect(
            runGuard(
              { [name]: empty },
              event,
              "refs/heads/main",
              revision,
              observed,
            ),
          ).rejects.toThrow(name);
          expect(observed.apiCalls).toBe(0);
          expect(observed.logs.length).toBe(0);
        }
      }
    }
  });
  test("checked main push and manual main production or manual staging pass", async () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const observed = { apiCalls: 0, logs: [] };
      await runGuard({}, event, "refs/heads/main", revision, observed);
      expect(observed.apiCalls).toBe(event === "push" ? 1 : 0);
      expect(observed.logs.length).toBe(0);
    }

    await runGuard(
      { ARC_STAGE: "staging" },
      "workflow_dispatch",
      "refs/heads/repair",
    );
  });
  test("staging accepts or defaults localhost OAuth while production requires an HTTPS Website origin", async () => {
    for (const website of ["http://localhost:3000", undefined]) {
      await runGuard(
        { ARC_STAGE: "staging", ARC_WEBSITE_URL: website },
        "workflow_dispatch",
        "refs/heads/repair",
      );
      await expect(runGuard({ ARC_WEBSITE_URL: website })).rejects.toThrow(
        "ARC_WEBSITE_URL",
      );
    }

    for (const website of [
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://remote.invalid",
      "http://user@localhost:3000",
      "http://localhost:3000?x=1",
      "http://localhost:3000/extra",
    ]) {
      await expect(
        runGuard(
          { ARC_STAGE: "staging", ARC_WEBSITE_URL: website },
          "workflow_dispatch",
          "refs/heads/repair",
        ),
      ).rejects.toThrow("ARC_WEBSITE_URL");
    }
  });

  test("PR origins, stale automatic commits, arbitrary revisions, wrong application IDs, and missing or invalid origins fail", async () => {
    for (const event of ["pull_request", "pull_request_target", "workflow_run"])
      await expect(runGuard({}, event)).rejects.toThrow("PR origins");
    await expect(runGuard({}, "push", "refs/heads/other")).rejects.toThrow(
      "exact checked main",
    );
    await expect(
      runGuard({}, "workflow_dispatch", "refs/heads/other"),
    ).rejects.toThrow("Manual production");
    await expect(
      runGuard({}, "push", "refs/heads/main", "b".repeat(40)),
    ).rejects.toThrow("Stale automatic");
    await expect(
      runGuard({ ARC_BUILD_REVISION: "b".repeat(40) }),
    ).rejects.toThrow("exact checked main");
    await expect(
      runGuard({ ARC_BUILD_REVISION: "a".repeat(7) }),
    ).rejects.toThrow("full SHA");
    await expect(
      runGuard({ DISCORD_APPLICATION_ID: "987654321" }),
    ).rejects.toThrow("application_id");
    await expect(runGuard({ RELEASE_APPLICATION_ID: "" })).rejects.toThrow(
      "PROD_DISCORD_APPLICATION_ID",
    );

    for (const origin of [
      "",
      "https://example.invalid/path",
      "http://example.invalid",
      "https://example.invalid/",
    ]) {
      await expect(runGuard({ ARC_BOT_URL: origin })).rejects.toThrow();
      await expect(runGuard({ ARC_WEBSITE_URL: origin })).rejects.toThrow();
    }
  });
});
