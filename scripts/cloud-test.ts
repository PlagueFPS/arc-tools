import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { CloudSettings, cloudSettings } from "./cloud-settings.js";

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
    ARC_CLOUD_STAGE: `test-foundation-${worktree}-${run}`,
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
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(TWITCH_|DISCORD_|TURSO_|ARC_|OPERATOR_)/.test(key),
  ),
);
const env = {
  ...inherited,
  CI: process.env.CI ?? "false",
  ALCHEMY_PROFILE: settings.profile,
  ALCHEMY_TEST_STAGE: settings.stage,
  ARC_CLOUD_STAGE: settings.stage,
  ARC_CLOUD_RUN: settings.run,
  ARC_STAGE: settings.stage,
  APPLICATION_STAGE: settings.stage,
  ARC_ENVIRONMENT: "test",
  TWITCH_SENDER_KIND: "synthetic",
  TWITCH_SENDER_LOGIN: "fixture_sender",
  TWITCH_CHANNEL_LOGINS: "fixture_channel",
  TWITCH_CLIENT_ID: "fixture-twitch",
  DISCORD_APPLICATION_ID: "fixture-discord",
  TWITCH_CLIENT_SECRET: "fixture-secret",
  TWITCH_SIGNING_SECRET: "fixture-signing",
  DISCORD_BOT_TOKEN: "fixture-token",
  DISCORD_PUBLIC_KEY: "fixture-key",
  OPERATOR_SECRET: "fixture-operator",
};
cloudSettings(env);
console.info(
  `Cloudflare foundation stage ${settings.stage}, profile ${settings.profile}`,
);
async function execute(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 300_000,
  });
  return await child.exited;
}
let testResult = 0;
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
    new URL("result.json", directory),
    JSON.stringify({ ...settings, testResult, cleanupResult }, null, 2),
  );
}
console.info(
  `Foundation tests exit ${testResult}; cleanup exit ${cleanupResult}`,
);
console.info(`Retry cleanup with bun run test:cloud:cleanup ${settings.stage}`);
process.exit(testResult || cleanupResult);
