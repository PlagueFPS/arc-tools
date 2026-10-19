import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { CloudSettings, syntheticEnvironment } from "./cloud-settings.js";
import {
  CheckedPreview,
  type PreviewIdentity,
  PreviewOutput,
  PullRequest,
  previewAction,
  previewDecision,
  previewIdentity,
} from "./preview-identity.js";

const marker = "<!-- arc-tools-synthetic-preview -->";
type PreviewRequest =
  | { action: "cleanup"; preview: PreviewIdentity }
  | { action: "deploy"; preview: PreviewIdentity; checked: CheckedPreview };

export type PreviewOperations = {
  readPr: () => Promise<PullRequest>;
  deploy: (origin: string) => Promise<typeof PreviewOutput.Type>;
  cleanup: () => Promise<void>;
  health: (url: string, checked: CheckedPreview) => Promise<void>;
  publish: (body: string) => Promise<void>;
};

export async function reconcilePreview(
  request: PreviewRequest,
  operations: PreviewOperations,
) {
  const pr = await operations.readPr();
  if (request.action === "cleanup") {
    if (pr.state !== "closed")
      throw new Error("Preview cleanup requires a closed PR");
    await operations.cleanup();
    await operations.publish("Synthetic preview removed. Cleanup verified.");
    return "destroyed";
  }
  const decision = previewDecision(pr, request.checked);
  if (decision === "destroy") {
    await operations.cleanup();
    await operations.publish("Synthetic preview removed. Cleanup verified.");
    return "destroyed";
  }
  if (decision === "stale") return "stale";
  await operations.publish(
    `Synthetic preview deploying. Checked merge ${request.checked.revision}; PR head ${request.checked.head}.`,
  );
  let output = await operations.deploy("");
  for (const phase of ["origin", "health", "publish"]) {
    const current = previewDecision(await operations.readPr(), request.checked);
    if (current === "destroy") {
      await operations.cleanup();
      await operations.publish("Synthetic preview removed. Cleanup verified.");
      return "destroyed";
    }
    if (current === "stale") return "stale";
    if (output.stage !== request.preview.stage)
      throw new Error("Deployed preview stage mismatch");
    if (phase === "origin") {
      const origin = output.url;
      output = await operations.deploy(origin);
      if (output.url !== origin)
        throw new Error(
          "Preview origin changed during explicit-origin redeploy",
        );
    } else if (phase === "health") {
      await operations.health(output.url, request.checked);
    }
  }
  await operations.publish(
    `Synthetic service preview: ${output.url}\n\nChecked merge: ${request.checked.revision}\nPR head: ${request.checked.head}\nStage: ${request.preview.stage}\n\nThis service uses fixture identities. It is not a live Twitch or Discord bot. Fixture state belongs to this PR and may survive pushes.`,
  );
  return "deployed";
}

const Comments = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    body: Schema.NullOr(Schema.String),
    user: Schema.Struct({ login: Schema.String }),
  }),
);
const Health = Schema.Struct({
  status: Schema.Literal("ready"),
  stage: PreviewOutput.fields.stage,
  revision: CheckedPreview.fields.revision,
});

async function main() {
  const { action, number } = previewAction(process.argv.slice(2));
  const preview = previewIdentity({
    repository: process.env.GITHUB_REPOSITORY ?? "PlagueFPS/arc-tools",
    number,
  });
  const request: PreviewRequest =
    action === "cleanup"
      ? { action, preview }
      : {
          action,
          preview,
          checked: Schema.decodeUnknownSync(CheckedPreview)({
            revision: process.env.PREVIEW_REVISION,
            head: process.env.PREVIEW_HEAD_SHA,
          }),
        };
  for (const [key, label] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: "repository variable CLOUDFLARE_TEST_ACCOUNT_ID",
    CLOUDFLARE_API_TOKEN: "repository secret CLOUDFLARE_TEST_API_TOKEN",
    GITHUB_TOKEN: "GITHUB_TOKEN with pull-requests: write",
  })) {
    if (!process.env[key]) throw new Error(`Configure ${label}`);
  }
  const settings = Schema.decodeUnknownSync(CloudSettings)({
    stage: preview.stage,
    run: preview.run,
    profile: process.env.ALCHEMY_PROFILE ?? "default",
  });
  const directory = new URL(
    `../.cloud-tests/${preview.stage}/`,
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("run.json", directory),
    JSON.stringify(
      {
        ...settings,
        ...preview,
        ...("checked" in request ? request.checked : {}),
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `stage=${preview.stage}\n`);
  const env = {
    ...syntheticEnvironment(process.env, settings),
    ARC_BUILD_REVISION:
      "checked" in request ? request.checked.revision : "unreleased",
    ARC_PUBLIC_URL: "",
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(
      `https://api.github.com/repos/${preview.repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        // The caller supplies the method; GET calls leave the body undefined.
        // oxlint-disable-next-line unicorn/no-invalid-fetch-options
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const execute = async (script: string, origin = "") => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "run",
        fileURLToPath(new URL(script, import.meta.url)),
      ],
      {
        cwd: fileURLToPath(directory),
        env: { ...env, ARC_PUBLIC_URL: origin },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        timeout: 600_000,
      },
    );
    if ((await child.exited) !== 0)
      throw new Error(
        `Preview ${script} failed; retain ${preview.stage} recovery journals`,
      );
  };
  let result = "failed";
  try {
    result = await reconcilePreview(request, {
      readPr: async () =>
        Schema.decodeUnknownSync(PullRequest)(
          await api(`pulls/${preview.number}`),
        ),
      deploy: async (origin) => {
        await execute("preview-cloud.ts", origin);
        return Schema.decodeUnknownSync(PreviewOutput)(
          JSON.parse(
            await readFile(new URL("preview-output.json", directory), "utf8"),
          ),
        );
      },
      cleanup: () => execute("cloud-cleanup.ts"),
      health: async (url, checked) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            const response = await fetch(`${url}/health`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) {
              const value = Schema.decodeUnknownSync(Health)(
                await response.json(),
              );
              if (
                value.stage === preview.stage &&
                value.revision === checked.revision
              )
                return;
            }
          } catch {}
          if (attempt < 59) await Bun.sleep(1000);
        }
        throw new Error(
          "Preview health did not match the exact stage and checked merge revision",
        );
      },
      publish: async (body) => {
        let existing: number | undefined;
        for (let page = 1; ; page++) {
          const comments = Schema.decodeUnknownSync(Comments)(
            await api(
              `issues/${preview.number}/comments?per_page=100&page=${page}`,
            ),
          );
          existing = comments.find(
            (comment) =>
              comment.user.login === "github-actions[bot]" &&
              comment.body?.includes(marker),
          )?.id;
          if (existing || comments.length < 100) break;
        }
        await api(
          existing
            ? `issues/comments/${existing}`
            : `issues/${preview.number}/comments`,
          existing ? "PATCH" : "POST",
          { body: `${marker}\n${body}` },
        );
      },
    });
    console.info(`Preview ${preview.stage}: ${result}`);
  } finally {
    await writeFile(
      new URL("preview-result.json", directory),
      JSON.stringify({ ...preview, action, result }, null, 2),
    );
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Preview failed");
    process.exitCode = 1;
  });
}
