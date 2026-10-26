import * as Cloudflare from "@alchemy.run/cloudflare";
import { AccountEndpoints } from "@arctools/twitch/cloudflare";
import { Effect, Layer, Schema } from "effect";

import type { EnvironmentConfig } from "../../apps/bot/src/config.js";
import type {
  TenantBoundaryObserver,
  TenantTrace,
} from "../../apps/bot/src/tenant-diagnostics.js";
import { CacheSource } from "../../packages/arc-data/src/cloudflare.js";
import { journeyUrl } from "./fixture-routing.js";
import { MetaforgeWorker } from "./metaforge.js";
import { TwitchProviderFixture } from "./twitch-provider-fixture.js";

export function botRequestObservation(identity: EnvironmentConfig) {
  if (
    identity.kind !== "test" ||
    !/^test-tenant-[a-f0-9]{8}-[a-f0-9]{12}$/.test(identity.stage)
  )
    throw new Error(
      "Request observation requires an isolated synthetic tenant stage",
    );
  let lookups = 0;
  let rpcs = 0;
  let trace: TenantTrace | null = null;

  const observer: typeof TenantBoundaryObserver.Service = {
    lookup: () => {
      lookups++;
    },
    rpc: () => {
      rpcs++;
    },
    result: (value) => {
      trace = value;
    },
  };

  return {
    observer,
    headers: () => {
      const headers = {
        "x-arc-tenant-lookups": String(lookups),
        "x-arc-tenant-rpcs": String(rpcs),
      };

      if (trace === null) return headers;

      return {
        ...headers,
        "x-arc-tenant-phase": trace.phase,
        "x-arc-tenant-code": trace.code,
        "x-arc-admission-delta-ms": String(trace.admissionDeltaMs),
        "x-arc-tenant-cutoff": String(trace.cutoff),
        "x-arc-tenant-activation": trace.activation,
      };
    },
  };
}

export const botTestBindings = Effect.fnUntraced(function* (
  identity: EnvironmentConfig,
) {
  if (identity.kind !== "test" || !identity.stage.startsWith("test-tenant-"))
    return yield* Effect.die(
      "Bot fixtures require an isolated synthetic tenant test stage",
    );
  const source = yield* Cloudflare.Worker(MetaforgeWorker.LogicalId, {});

  const provider = yield* Cloudflare.Worker(
    TwitchProviderFixture.LogicalId,
    {},
  );

  const sourceUrl = yield* source.url;
  const providerUrl = yield* provider.url;

  return Layer.merge(
    Layer.succeed(CacheSource, {
      options: Effect.gen(function* () {
        const baseUrl = yield* sourceUrl;

        if (
          !Schema.is(Schema.String)(baseUrl) ||
          !(
            baseUrl.startsWith("https://") ||
            /^http:\/\/localhost:\d+$/.test(baseUrl)
          )
        )
          return yield* Effect.die("Synthetic source URL unavailable");

        return { baseUrl: journeyUrl(baseUrl, "bot") };
      }),
    }),
    Layer.succeed(AccountEndpoints, {
      resolve: Effect.gen(function* () {
        const baseUrl = yield* providerUrl;

        if (
          !Schema.is(Schema.String)(baseUrl) ||
          !(
            baseUrl.startsWith("https://") ||
            /^http:\/\/localhost:\d+$/.test(baseUrl)
          )
        )
          return yield* Effect.die("Synthetic provider URL unavailable");

        return {
          api: `${journeyUrl(baseUrl, "bot")}/helix`,
          oauth: `${journeyUrl(baseUrl, "bot")}/oauth`,
        };
      }),
    }),
  );
});
