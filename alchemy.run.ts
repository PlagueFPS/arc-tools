import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema } from "effect";
import { Stage as StageSchema, TestStage } from "./apps/bot/src/config.js";
import { Bot } from "./apps/bot/src/worker.js";

export default Alchemy.Stack(
  "arc-tools",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    yield* Schema.decodeUnknownEffect(StageSchema)(stage).pipe(Effect.orDie);
    const configuredStage = yield* Config.schema(StageSchema, "ARC_STAGE");
    if (stage !== configuredStage) {
      return yield* Effect.die("ARC_STAGE must match the Alchemy stage");
    }
    if (stage === "prod" && (yield* AlchemyContext).dev) {
      return yield* Effect.die("Local development cannot select prod");
    }
    const bot = yield* Bot;
    if (Schema.is(TestStage)(stage)) {
      const { ProbeWorker } = yield* Effect.promise(
        () => import("./tests/cloud/probe.js"),
      );
      const probe = yield* ProbeWorker;
      if (stage.startsWith("test-cache-")) {
        const { CacheFixtureWorker } = yield* Effect.promise(
          () => import("./tests/cloud/cache-fixture.js"),
        );
        const { MetaforgeWorker } = yield* Effect.promise(
          () => import("./tests/cloud/metaforge.js"),
        );
        const source = yield* MetaforgeWorker;
        const cache = yield* CacheFixtureWorker;
        return {
          stage,
          url: bot.url,
          workerName: bot.workerName,
          probeUrl: probe.url,
          probeWorkerName: probe.workerName,
          cacheUrl: cache.url,
          cacheWorkerName: cache.workerName,
          sourceUrl: source.url,
          sourceWorkerName: source.workerName,
        };
      }
      return {
        stage,
        url: bot.url,
        workerName: bot.workerName,
        probeUrl: probe.url,
        probeWorkerName: probe.workerName,
      };
    }
    return { stage, url: bot.url, workerName: bot.workerName };
  }),
);
