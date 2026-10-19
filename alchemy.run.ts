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
    if (stage.startsWith("test-tenant-")) {
      const { MetaforgeWorker } = yield* Effect.promise(
        () => import("./tests/cloud/metaforge.js"),
      );
      const { TwitchProviderFixture } = yield* Effect.promise(
        () => import("./tests/cloud/twitch-provider-fixture.js"),
      );
      yield* MetaforgeWorker;
      yield* TwitchProviderFixture;
    }
    const bot = yield* Bot;
    if (Schema.is(TestStage)(stage)) {
      const { ProbeWorker } = yield* Effect.promise(
        () => import("./tests/cloud/probe.js"),
      );
      const probe = yield* ProbeWorker;
      if (
        stage.startsWith("test-cache-") ||
        stage.startsWith("test-account-") ||
        stage.startsWith("test-tenant-")
      ) {
        const { CacheFixtureWorker } = yield* Effect.promise(
          () => import("./tests/cloud/cache-fixture.js"),
        );
        const { MetaforgeWorker } = yield* Effect.promise(
          () => import("./tests/cloud/metaforge.js"),
        );
        const source = yield* MetaforgeWorker;
        const cache = yield* CacheFixtureWorker;
        if (
          stage.startsWith("test-account-") ||
          stage.startsWith("test-tenant-")
        ) {
          const { TwitchProviderFixture } = yield* Effect.promise(
            () => import("./tests/cloud/twitch-provider-fixture.js"),
          );
          const { AccountFixtureWorker } = yield* Effect.promise(
            () => import("./tests/cloud/account-fixture.js"),
          );
          const provider = yield* TwitchProviderFixture;
          const account = yield* AccountFixtureWorker;
          const tenant = stage.startsWith("test-tenant-")
            ? yield* Effect.promise(
                () => import("./tests/cloud/tenant-fixture.js"),
              ).pipe(
                Effect.flatMap(
                  ({ TenantFixtureWorker }) => TenantFixtureWorker,
                ),
              )
            : null;
          return {
            ...(tenant
              ? { tenantUrl: tenant.url, tenantWorkerName: tenant.workerName }
              : {}),
            stage,
            url: bot.url,
            workerName: bot.workerName,
            probeUrl: probe.url,
            probeWorkerName: probe.workerName,
            cacheUrl: cache.url,
            cacheWorkerName: cache.workerName,
            sourceUrl: source.url,
            sourceWorkerName: source.workerName,
            accountUrl: account.url,
            accountWorkerName: account.workerName,
            providerUrl: provider.url,
            providerWorkerName: provider.workerName,
          };
        }
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
