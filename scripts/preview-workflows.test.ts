/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { describe, expect, test } from "bun:test";
import { format } from "node:util";
import { runInNewContext } from "node:vm";

import {
  Schema,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
  Option as EffectOption,
} from "effect";

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
  const value = EffectOption.getOrUndefined(
    EffectOption.map(
      EffectOption.fromNullishOr(job(workflow, jobName).steps),
      (effectNativeValue0) =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            effectNativeValue0,
            (step) => !!(step.name === name),
          ),
        ),
    ),
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
  inputs: { stage?: string; operation?: string } = {},
) {
  if (!expression) return true;

  return (
    runInNewContext(
      `(${expression})`,
      { github, inputs },
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
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

const revision = EffectString.repeat(40)("a");

const app = "123456789";

const releaseSecretNames = [
  "TWITCH_CLIENT_SECRET",
  "TWITCH_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
  "OPERATOR_SECRET",
  "CLOUDFLARE_API_TOKEN",
] as const;

const fixtureSecrets = EffectRecord.fromEntries(
  EffectArray.map(releaseSecretNames, (name) => [
    name,
    `fixture-${name}-credential`,
  ]),
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
  comparison = "ahead",
) {
  const script = Schema.decodeUnknownSync(Schema.String)(guard.with?.script);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "process", "console", script)(
    {
      rest: {
        repos: {
          compareCommits: async () => {
            observed.apiCalls++;

            return { data: { status: comparison } };
          },
        },
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
        RELEASE_OPERATION: "release",
        ARC_STAGE: "prod",
        ARC_BUILD_REVISION: revision,
        RELEASE_APPLICATION_ID: app,
        DISCORD_APPLICATION_ID: app,
        ARC_BOT_URL: "https://existing.invalid",
        ARC_WEBSITE_URL: "https://website.invalid",
        ...overrides,
      },
    },
    EffectRecord.fromEntries(
      EffectArray.map(["log", "info", "warn", "error", "debug"], (name) => [
        name,
        (...values: unknown[]) => observed.logs.push(format(...values)),
      ]),
    ),
  );
}

describe("workflow event and dependency behavior", () => {
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
    expect(ci.jobs.preview).toBeUndefined();
    expect(job(ci, "release").needs).toBe("ci");
    expect(job(ci, "release").uses).toBe("./.github/workflows/release.yml");
  });
  test("automatic release explicitly forwards every required environment secret", () => {
    const caller = job(ci, "release");
    expect(() => checkSecretForwarding(caller)).not.toThrow();
    expect(EffectRecord.keys(caller.secrets ?? {}).sort()).toEqual(
      [...releaseSecretNames].sort(),
    );

    const called = Schema.decodeUnknownSync(callableRelease)(
      release.on.workflow_call,
    );

    expect(EffectRecord.keys(called.secrets).sort()).toEqual(
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
  test("all PR checks run workerd without cloud credentials or preview deployment", () => {
    const integration = step(ci, "ci", "Local workerd integration tests");
    expect(integration.run).toBe("bun --no-env-file run test:cloud");

    for (const fork of [false, true]) {
      expect(enabled(integration.if, context("pull_request", fork))).toBeTrue();
      expect(
        enabled(job(ci, "release").if, context("pull_request", fork)),
      ).toBeFalse();
    }

    expect(ci.jobs.preview).toBeUndefined();

    for (const entry of job(ci, "ci").steps ?? []) {
      expect(JSON.stringify(entry)).not.toContain("CLOUDFLARE_");
      expect(entry.run ?? "").not.toContain("preview:deploy");
    }

    expect(step(ci, "ci", "Retry local infrastructure cleanup").if).toContain(
      "always()",
    );
    expect(step(ci, "ci", "Preserve cleanup recovery identity").if).toContain(
      "always()",
    );
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
    expect(EffectRecord.keys(cleanup.on).sort()).toEqual([
      "pull_request_target",
      "workflow_dispatch",
    ]);

    const checkouts = EffectOption.getOrUndefined(
      EffectOption.map(
        EffectOption.fromNullishOr(close.steps),
        (effectNativeValue1) =>
          EffectArray.filter(
            effectNativeValue1,
            (entry) => !!(entry.uses === "actions/checkout@v4"),
          ),
      ),
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

      for (const value of EffectRecord.values(entry.env ?? {}))
        if (EffectString.includes("secrets.")(value))
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
  test("manual preview cleanup retains its PR lock and recovery artifacts", () => {
    const close = job(cleanup, "cleanup");

    const expand = (value: string, github: GithubContext, inputs = {}) =>
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replace supports the callback required to expand checked-in workflow expressions.
      value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) =>
        String(
          runInNewContext(
            `(${expression})`,
            { github, inputs },
            {
              timeout: 1000,
              contextCodeGeneration: { strings: false, wasm: false },
            },
          ),
        ),
      );

    const manual = context("workflow_dispatch");

    const manualContext = {
      ...manual,
      event: { ...manual.event, number: undefined },
    };

    expect(
      expand(close.concurrency?.group ?? "", manualContext, { pr: "10" }),
    ).toBe(`arc-preview-PlagueFPS/arc-tools-10`);

    for (const value of [close]) {
      expect(value.concurrency?.["cancel-in-progress"]).toBeFalse();
      expect(value.permissions?.["pull-requests"]).toBe("write");
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(
            EffectOption.fromNullishOr(value.steps),
            (effectNativeValue2) =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(
                  effectNativeValue2,
                  (step) => !!(step.uses === "actions/upload-artifact@v4"),
                ),
              ),
          ),
        )?.if,
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
      for (const value of EffectRecord.values(workflow.jobs))
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
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(owner.steps),
          (effectNativeValue3) =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                effectNativeValue3,
                (entry) => !!(entry.uses === "actions/checkout@v4"),
              ),
            ),
        ),
      )?.with?.ref,
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
          expect(
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
      expect(runGuard({ ARC_WEBSITE_URL: website })).rejects.toThrow(
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
      expect(
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
      expect(runGuard({}, event)).rejects.toThrow("PR origins");
    expect(runGuard({}, "push", "refs/heads/other")).rejects.toThrow(
      "exact checked main",
    );
    expect(
      runGuard({}, "workflow_dispatch", "refs/heads/other"),
    ).rejects.toThrow("Manual production");
    expect(
      runGuard({}, "push", "refs/heads/main", EffectString.repeat(40)("b")),
    ).rejects.toThrow("Stale automatic");
    expect(
      runGuard({ ARC_BUILD_REVISION: EffectString.repeat(40)("b") }),
    ).rejects.toThrow("exact checked main");
    expect(
      runGuard({ ARC_BUILD_REVISION: EffectString.repeat(7)("a") }),
    ).rejects.toThrow("full SHA");
    expect(runGuard({ DISCORD_APPLICATION_ID: "987654321" })).rejects.toThrow(
      "application_id",
    );
    expect(runGuard({ RELEASE_APPLICATION_ID: "" })).rejects.toThrow(
      "PROD_DISCORD_APPLICATION_ID",
    );

    for (const origin of [
      "",
      "https://example.invalid/path",
      "http://example.invalid",
      "https://example.invalid/",
    ]) {
      expect(runGuard({ ARC_BOT_URL: origin })).rejects.toThrow();
      expect(runGuard({ ARC_WEBSITE_URL: origin })).rejects.toThrow();
    }
  });
});

describe("Discord release preflight and sync-only recovery", () => {
  test("preflight gates deployment and sync-only skips all deployment mutations", () => {
    const steps = job(release, "release").steps ?? [];

    const preflight = step(
      release,
      "release",
      "Validate Discord application access before deployment",
    );

    const deploy = step(release, "release", "Deploy selected stage");

    const sync = step(
      release,
      "release",
      "Synchronize this release's global commands",
    );

    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(deploy));
    expect(steps.indexOf(deploy)).toBeLessThan(steps.indexOf(sync));
    expect(preflight.run).toContain("--preflight");

    for (const operation of ["release", "sync", undefined]) {
      expect(
        enabled(deploy.if, context("workflow_dispatch"), { operation }),
      ).toBe(operation !== "sync");
      expect(
        enabled(preflight.if, context("workflow_dispatch"), { operation }),
      ).toBe(operation !== "sync");
      expect(
        enabled(sync.if, context("workflow_dispatch"), { operation }),
      ).toBeTrue();
    }

    expect(sync.run).toContain('--revision "$ARC_BUILD_REVISION" --wait');
  });

  test("production recovery accepts only main-history revisions and needs no deployment secrets or Website configuration", async () => {
    const overrides = {
      RELEASE_OPERATION: "sync",
      ARC_BUILD_REVISION: EffectString.repeat(40)("b"),
      TWITCH_CLIENT_SECRET: undefined,
      TWITCH_SIGNING_SECRET: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
      OPERATOR_SECRET: undefined,
      ARC_WEBSITE_URL: undefined,
    };

    for (const comparison of ["ahead", "identical"]) {
      const observed = { apiCalls: 0, logs: [] };
      await runGuard(
        overrides,
        "workflow_dispatch",
        "refs/heads/main",
        revision,
        observed,
        comparison,
      );
      expect(observed.apiCalls).toBe(1);
      expect(observed.logs).toEqual([]);
    }

    for (const comparison of ["behind", "diverged"])
      expect(
        runGuard(
          overrides,
          "workflow_dispatch",
          "refs/heads/main",
          revision,
          { apiCalls: 0, logs: [] },
          comparison,
        ),
      ).rejects.toThrow("main history");
    expect(
      runGuard(overrides, "workflow_dispatch", "refs/heads/repair"),
    ).rejects.toThrow("main");
    expect(runGuard(overrides, "push")).rejects.toThrow("manual dispatch");
    expect(
      runGuard({ ...overrides, DISCORD_BOT_TOKEN: "" }, "workflow_dispatch"),
    ).rejects.toThrow("DISCORD_BOT_TOKEN");
    expect(runGuard({ RELEASE_OPERATION: "other" })).rejects.toThrow(
      "operation",
    );
  });
});
