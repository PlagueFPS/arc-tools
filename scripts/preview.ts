/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Effect, Redacted, Schema, Record as EffectRecord } from "effect";
import { FetchHttpClient } from "effect/http";

import { CloudSettings, syntheticEnvironment } from "./cloud-settings.js";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makePreviewHttp } from "./preview-http.js";
import {
  CheckedPreview,
  type PreviewIdentity,
  PreviewOutput,
  type PullRequest,
  previewAction,
  previewDecision,
  previewIdentity,
} from "./preview-identity.js";

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

  for (const [key, label] of EffectRecord.toEntries({
    CLOUDFLARE_ACCOUNT_ID: "repository variable CLOUDFLARE_TEST_ACCOUNT_ID",
    CLOUDFLARE_API_TOKEN: "repository secret CLOUDFLARE_TEST_API_TOKEN",
    GITHUB_TOKEN: "GITHUB_TOKEN with pull-requests: write",
  })) {
    if (!process.env[key]) throw new Error(`Configure ${label}`);
  }

  const settings = Schema.decodeSync(CloudSettings)({
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
      "checked" in request
        ? { ...settings, ...preview, ...request.checked }
        : { ...settings, ...preview },
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
    ARC_BOT_URL: "",
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };

  const http = await Effect.runPromise(
    makePreviewHttp({
      preview,
      token: Redacted.make(process.env.GITHUB_TOKEN ?? ""),
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This CLI or deployment entry point owns the composed layer scope.
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "follow",
      }),
    ),
  );

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
        env: { ...env, ARC_BOT_URL: origin },
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
      readPr: () => Effect.runPromise(http.readPr()),
      deploy: async (origin) => {
        await execute("preview-cloud.ts", origin);

        return Schema.decodeUnknownSync(PreviewOutput)(
          JSON.parse(
            await readFile(new URL("preview-output.json", directory), "utf8"),
          ),
        );
      },
      cleanup: () => execute("cloud-cleanup.ts"),
      health: (url, checked) => Effect.runPromise(http.health(url, checked)),
      publish: (body) => Effect.runPromise(http.publish(body)),
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
  await main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : "Preview failed");
    process.exitCode = 1;
  });
}
