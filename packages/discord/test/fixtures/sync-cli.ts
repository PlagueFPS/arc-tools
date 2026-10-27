/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/process-env -- Host environment snapshots are parsed at the CLI or subprocess boundary. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import {
  commandManifest,
  manifestHash,
  RemoteCommands,
} from "@arctools/discord/server";
import { Effect, Schema } from "effect";

const hash = await Effect.runPromise(manifestHash);

let remote: RemoteCommands =
  process.env.SYNC_SCENARIO === "lost-write" ? [] : commandManifest;

let failed = false;

globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const health = new URL(request.url).pathname === "/health";
    console.info(
      JSON.stringify({
        event: "fixture-request",
        operation: health ? "health" : "commands",
        method: request.method,
      }),
    );

    if (health)
      return Response.json({
        status: "ready",
        stage: "prod",
        revision: process.env.SYNC_SCENARIO === "stale" ? "other" : "revision",
        manifestHash: hash,
      });

    if (process.env.SYNC_SCENARIO === "auth")
      return Response.json(
        { code: 50001, message: "canary-response", token: "canary-token" },
        { status: 401 },
      );

    if (request.method === "PUT") {
      remote = Schema.decodeUnknownSync(RemoteCommands)(await request.json());

      if (!failed) {
        failed = true;
        throw new Error("canary-network");
      }
    }

    return Response.json(remote);
  },
  { preconnect: fetch.preconnect },
);
