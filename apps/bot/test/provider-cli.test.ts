/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Schema, Array as Arr, String as Str } from "effect";

const root = resolve(import.meta.dir, "../../..");

const Calls = Schema.Array(
  Schema.Struct({
    url: Schema.String,
    authorization: Schema.NullOr(Schema.String),
    redirect: Schema.String,
  }),
);

for (const operation of ["sync", "status", "setup"])
  test(`the ${operation} CLI installs provider transport and scopes Discord credentials to Discord`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "arc-provider-cli-"));

    try {
      const capture = join(directory, "calls.json");
      const preload = join(directory, "provider.ts");
      await writeFile(
        preload,
        `
import { writeFileSync } from "node:fs";
import { commandManifest, canonicalManifest } from ${JSON.stringify(join(root, "packages/discord/src/server.ts"))};
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalManifest(commandManifest))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const calls = [];
process.on("exit", () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify(calls)));
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(String(input));
  const authorization = new Headers(init?.headers).get("authorization");
  calls.push({ url: url.toString(), authorization, redirect: init?.redirect });
  if (url.origin === "https://release.invalid" && url.pathname === "/health") return Response.json({ status: "ready", stage: "staging", revision: "cli-revision", manifestHash: hash });
  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/applications/cli-application/commands") return Response.json(commandManifest);
  if (url.origin === "https://release.invalid" && url.pathname.startsWith("/ops/")) {
    const status = { stage: "staging", revision: "cli-revision", setup: "ready", credential: "valid", sender: null, channels: [], attempts: 0, credentialCheckAt: null };
    return Response.json(url.pathname.endsWith("/setup") ? { status, authorizations: [] } : status);
  }
  throw new Error("Unexpected provider CLI request");
}, { preconnect: fetch.preconnect });
`,
      );

      const script =
        operation === "sync" ? "sync-discord-commands.ts" : "ops.ts";

      const args = operation === "sync" ? [] : [operation, "--discord"];

      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--preload",
          preload,
          join(root, "scripts", script),
          ...args,
          "--stage",
          "staging",
          "--endpoint",
          "https://release.invalid",
          "--revision",
          "cli-revision",
        ],
        {
          cwd: root,
          env: {
            PATH: dirname(process.execPath),
            OPERATOR_SECRET: "cli-operator",
            DISCORD_APPLICATION_ID: "cli-application",
            DISCORD_BOT_TOKEN: "cli-bot-token",
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

      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain(
        operation === "sync" ? '"changed":false' : '"discordDrift":false',
      );

      const calls = Schema.decodeUnknownSync(Calls)(
        await Bun.file(capture).json(),
      );

      expect(calls.length).toBeGreaterThan(2);
      expect(
        Arr.every(calls, (call) => !!(call.redirect === "manual")),
      ).toBeTrue();

      for (const call of calls) {
        const url = new URL(call.url);
        expect(call.authorization).toBe(
          url.origin === "https://discord.com"
            ? "Bot cli-bot-token"
            : Str.startsWith("/ops/")(url.pathname)
              ? "Bearer cli-operator"
              : null,
        );
      }

      expect(
        Arr.filter(
          calls,
          (call) => !!(new URL(call.url).origin === "https://discord.com"),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
