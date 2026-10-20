import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { Match, Schema } from "effect";

import {
  CloudSettings,
  cloudSettings,
  syntheticEnvironment,
} from "./cloud-settings.js";

const suite = Match.value(process.argv[2]).pipe(
  Match.when("foundation", () => "foundation"),
  Match.when("cache", () => "cache"),
  Match.when("account", () => "account"),
  Match.orElse(() => "tenant"),
);

const cleanupOnly = process.argv[2] === "cleanup";

let settings: CloudSettings;

if (cleanupOnly) {
  const stage = process.argv[3] ?? process.env.ARC_CLOUD_STAGE;

  if (!stage)
    throw new Error(
      "Cleanup requires the exact test stage from the run output",
    );
  const validated = Schema.decodeUnknownSync(CloudSettings.fields.stage)(stage);

  const journal = new URL(
    `../.cloud-tests/${validated}/run.json`,
    import.meta.url,
  );

  settings = Schema.decodeUnknownSync(CloudSettings)(
    JSON.parse(await readFile(journal, "utf8")),
  );

  if (settings.stage !== validated)
    throw new Error("Cleanup journal stage mismatch");
} else {
  const run = randomBytes(6).toString("hex");

  const worktree = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 8);

  settings = cloudSettings({
    ...process.env,
    ARC_CLOUD_STAGE: `test-${suite}-${worktree}-${run}`,
    ARC_CLOUD_RUN: run,
  });
}

const directory = new URL(
  `../.cloud-tests/${settings.stage}/`,
  import.meta.url,
);

await mkdir(directory, { recursive: true });

await writeFile(
  new URL("run.json", directory),
  JSON.stringify(settings, null, 2),
);

if (process.env.GITHUB_OUTPUT && !cleanupOnly) {
  await appendFile(process.env.GITHUB_OUTPUT, `stage=${settings.stage}\n`);
}

const env = syntheticEnvironment(process.env, settings);

console.info(
  `Cloudflare ${suite} stage ${settings.stage}, profile ${settings.profile}`,
);

async function execute(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 600_000,
  });

  return await child.exited;
}

const resultFile = new URL("result.json", directory);

let testResult = cleanupOnly ? 1 : 0;

if (cleanupOnly && existsSync(resultFile)) {
  const previous = Schema.decodeUnknownSync(
    Schema.Struct({
      stage: CloudSettings.fields.stage,
      testResult: Schema.Int,
    }),
  )(JSON.parse(await readFile(resultFile, "utf8")));

  if (previous.stage !== settings.stage)
    throw new Error("Cleanup result stage mismatch");
  testResult = previous.testResult;
}

let cleanupResult = 1;

try {
  if (!cleanupOnly)
    testResult = await execute([
      process.execPath,
      "test",
      "./tests/cloud/foundation.test.ts",
    ]);
} finally {
  cleanupResult = await execute([
    process.execPath,
    "run",
    "./scripts/cloud-cleanup.ts",
  ]);
  await writeFile(
    resultFile,
    JSON.stringify({ ...settings, testResult, cleanupResult }, null, 2),
  );
}

console.info(`Cloud tests exit ${testResult}; cleanup exit ${cleanupResult}`);

console.info(`Retry cleanup with bun run test:cloud:cleanup ${settings.stage}`);

process.exit(cleanupOnly ? cleanupResult : testResult || cleanupResult);
