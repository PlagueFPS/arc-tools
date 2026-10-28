/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { Match, Schema, String as Str } from "effect";

import { cleanupLocalTest } from "./local-test-cleanup.js";
import {
  LocalTestSettings,
  localTestEnvironment,
  localTestSettings,
} from "./local-test-settings.js";

const suite = Match.value(process.argv[2]).pipe(
  Match.when("foundation", () => "foundation"),
  Match.when("cache", () => "cache"),
  Match.when("account", () => "account"),
  Match.orElse(() => "tenant"),
);

const cleanupOnly = process.argv[2] === "cleanup";

let settings: typeof LocalTestSettings.Type;

if (cleanupOnly) {
  const stage = process.argv[3] ?? process.env.ARC_CLOUD_STAGE;

  if (!stage)
    throw new Error(
      "Cleanup requires the exact test stage from the run output",
    );

  const validated = Schema.decodeSync(LocalTestSettings.fields.stage)(stage);

  const journal = new URL(
    `../.cloud-tests/${validated}/run.json`,
    import.meta.url,
  );

  settings = Schema.decodeUnknownSync(LocalTestSettings)(
    JSON.parse(await readFile(journal, "utf8")),
  );

  if (settings.stage !== validated)
    throw new Error("Cleanup journal stage mismatch");
} else {
  const run = randomBytes(6).toString("hex");

  const worktree = Str.slice(
    0,
    8,
  )(createHash("sha256").update(process.cwd()).digest("hex"));

  settings = localTestSettings({
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
  JSON.stringify({ ...settings, dev: true }, null, 2),
);

if (process.env.GITHUB_OUTPUT && !cleanupOnly) {
  await appendFile(process.env.GITHUB_OUTPUT, `stage=${settings.stage}\n`);
}

const env = localTestEnvironment(process.env, settings);

console.info(
  `Local workerd ${suite} stage ${settings.stage}, profile ${settings.profile}`,
);

async function execute(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: directory.pathname,
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

if (cleanupOnly && (await Bun.file(resultFile).exists())) {
  const previous = Schema.decodeUnknownSync(
    Schema.Struct({
      stage: LocalTestSettings.fields.stage,
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
      "--no-env-file",
      "test",
      new URL("../tests/cloud/foundation.test.ts", import.meta.url).pathname,
    ]);
} finally {
  try {
    await cleanupLocalTest(directory, settings.stage);
    cleanupResult = 0;
  } catch (error) {
    console.error(error);
  }

  await writeFile(
    resultFile,
    JSON.stringify({ ...settings, testResult, cleanupResult }, null, 2),
  );
}

console.info(
  `Local infrastructure tests exit ${testResult}; cleanup exit ${cleanupResult}`,
);

console.info(`Retry cleanup with bun run test:cloud:cleanup ${settings.stage}`);

process.exit(cleanupOnly ? cleanupResult : testResult || cleanupResult);
