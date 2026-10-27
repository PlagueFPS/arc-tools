import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { StackProps, StackServices } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema, String as EffectString } from "effect";

import { Stage as StageSchema, TestStage } from "./apps/bot/src/config.js";
import BotLive, { Bot } from "./apps/bot/src/worker.js";
import { Website } from "./stacks/website.js";

export { Website };

export const makeStack = (
  options: StackProps<Cloudflare.Providers | StackServices>,
) =>
  Alchemy.Stack(
    "arc-tools",
    options,
    Effect.gen(function* () {
      const stage = yield* Stage;
      yield* Schema.decodeEffect(StageSchema)(stage).pipe(Effect.orDie);
      const configuredStage = yield* Config.schema(StageSchema, "ARC_STAGE");

      if (stage !== configuredStage) {
        return yield* Effect.die("ARC_STAGE must match the Alchemy stage");
      }

      if (stage === "prod" && (yield* AlchemyContext).dev) {
        return yield* Effect.die("Local development cannot select prod");
      }

      if (EffectString.startsWith("test-tenant-")(stage)) {
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
          EffectString.startsWith("test-cache-")(stage) ||
          EffectString.startsWith("test-account-")(stage) ||
          EffectString.startsWith("test-tenant-")(stage)
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
            EffectString.startsWith("test-account-")(stage) ||
            EffectString.startsWith("test-tenant-")(stage)
          ) {
            const { TwitchProviderFixture } = yield* Effect.promise(
              () => import("./tests/cloud/twitch-provider-fixture.js"),
            );

            const { AccountFixtureWorker } = yield* Effect.promise(
              () => import("./tests/cloud/account-fixture.js"),
            );

            const provider = yield* TwitchProviderFixture;
            const account = yield* AccountFixtureWorker;

            const tenant = EffectString.startsWith("test-tenant-")(stage)
              ? yield* Effect.promise(
                  () => import("./tests/cloud/tenant-fixture.js"),
                ).pipe(
                  Effect.flatMap(
                    ({ TenantFixtureWorker }) => TenantFixtureWorker,
                  ),
                )
              : null;

            const output = {
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

            return tenant
              ? {
                  ...output,
                  tenantUrl: tenant.url,
                  tenantWorkerName: tenant.workerName,
                }
              : output;
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

      const website = yield* Website;

      return {
        stage,
        url: bot.url,
        workerName: bot.workerName,
        websiteUrl: website.url,
      };
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This CLI or deployment entry point owns the composed layer scope.
    }).pipe(Effect.provide(BotLive)),
  );

export default makeStack({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});
