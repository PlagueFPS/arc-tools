#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import * as Cloudflare from "alchemy/Cloudflare";
import { State } from "alchemy/State";
import * as Core from "alchemy/Test/Core";
import { Effect, Schema } from "effect";

import Stack from "../../../../alchemy.run.ts";
import { manifestHash } from "../../../../apps/bot/src/discord-manifest.ts";
import { signDiscord } from "../../../../tests/cloud/signatures.ts";

const action = process.argv[2];
const stage = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^local-verify-[a-z0-9-]+$/)),
)(process.argv[3]);
const endpoint = new URL(process.env.ARC_VERIFY_URL ?? "http://localhost:1337");
assert(["localhost", "127.0.0.1"].includes(endpoint.hostname));
assert.equal(endpoint.protocol, "http:");
const directory = `.cloud-tests/verify-arctools/${stage}`;
await mkdir(directory, { recursive: true });

async function record(name: string, value: unknown) {
  await writeFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2));
}

async function doctor() {
  const launch = await readFile(`${directory}/launch.log`, "utf8");
  assert(launch.includes(stage), "No launch record for this stage");
  assert(launch.includes(endpoint.origin), "Endpoint differs from launch log");
  const response = await fetch(new URL("/health", endpoint), {
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  const observation = {
    endpoint: endpoint.href,
    status: response.status,
    body,
  };
  await record("doctor", observation);
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    status: "ready",
    stage,
    revision: process.env.ARC_BUILD_REVISION,
    manifestHash: await Effect.runPromise(manifestHash),
  });
  return observation;
}

if (action === "cleanup") {
  const options = {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    stage,
    profile: process.env.ALCHEMY_PROFILE ?? "default",
    dev: true,
  };
  await Core.run(
    Effect.gen(function* () {
      yield* Core.destroy(options, Stack);
      const state = yield* yield* State;
      const key = { stack: Stack.stackName, stage };
      assert.deepEqual(yield* state.list(key), []);
      assert.equal(yield* state.getOutput(key), undefined);
    }),
    options,
  );
  const reachable = await fetch(new URL("/health", endpoint), {
    signal: AbortSignal.timeout(2000),
  }).then(
    () => true,
    () => false,
  );
  assert.equal(
    reachable,
    false,
    "Stop this run's launch terminal before cleanup",
  );
  for (const path of [
    `.alchemy/bundles/arc-tools-${stage}-Bot`,
    ...["ArcCache", "Tenant", "TwitchAccount"].map(
      (name) => `.alchemy/local/arc-tools-bot-${stage}-${name}`,
    ),
  ])
    await rm(path, { recursive: true, force: true });
  await record("cleanup", {
    stage,
    stateEntries: 0,
    outputAbsent: true,
    listenerStopped: true,
  });
  process.stdout.write(`Cleanup passed; evidence retained in ${directory}\n`);
} else if (action === "doctor" || action === "drive") {
  await doctor();
  if (action === "drive") {
    const observations: unknown[] = [];
    async function send(name: string, input: unknown, valid = true) {
      const body = ` ${JSON.stringify(input)}\n`;
      const headers = await Effect.runPromise(
        signDiscord(new TextEncoder().encode(body)),
      );
      if (!valid) headers["x-signature-ed25519"] = "0".repeat(128);
      const response = await fetch(new URL("/interactions/discord", endpoint), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const result = {
        name,
        request: { path: "/interactions/discord", headers, body },
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        },
      };
      observations.push(result);
      await record("discord-access", observations);
      return result.response;
    }
    const ping = { application_id: "fixture-discord", type: 1 };
    const accepted = await send("signed-ping", ping);
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { type: 1 });
    const rejected = await send("invalid-signature", ping, false);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body, "");
    const dm = await send("dm-command", {
      application_id: "fixture-discord",
      type: 2,
      context: 1,
      id: crypto.randomUUID(),
      data: {
        type: 1,
        name: "sell",
        options: [{ type: 3, name: "item", value: "sensors" }],
      },
    });
    assert.equal(dm.status, 200);
    assert.deepEqual(JSON.parse(dm.body), {
      type: 4,
      data: {
        content: "Use a slash command from an installed server.",
        flags: 64,
        allowed_mentions: { parse: [], replied_user: false },
      },
    });
    await record("drive-result", { feature: "discord-access", passed: true });
    process.stdout.write(
      `Discord access passed; requests and responses in ${directory}\n`,
    );
  } else process.stdout.write(`Doctor passed for ${stage}\n`);
} else throw new Error("Use doctor, drive, or cleanup");
