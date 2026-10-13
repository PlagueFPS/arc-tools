import { BunServices } from "@effect/platform-bun";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import { Context, Effect } from "effect";
import { workerCompatibility } from "../src/config.ts";
import { jobRuntime } from "../src/jobs.ts";

await Effect.runPromise(
  Effect.gen(function* () {
    const bundle = yield* WorkerBundle;
    const durableObject = {
      kind: "durableObject",
      constructor: jobRuntime,
      services: Context.empty(),
    } satisfies import("alchemy/Cloudflare/Workers/DurableObject").DurableObjectExport;
    yield* bundle.build({
      id: "ArcBot",
      main: new URL("../src/worker.ts", import.meta.url).pathname,
      stack: { name: "arc-bot", stage: "local" },
      compatibility: workerCompatibility,
      entry: {
        kind: "effect",
        exports: { TwitchChannel: durableObject, DiscordGuild: durableObject },
      },
      extraOptions: {
        output: {
          dir: "dist",
          entryFileNames: "worker.js",
          codeSplitting: false,
        },
      },
    });
  }).pipe(Effect.provide(BunServices.layer)),
);
