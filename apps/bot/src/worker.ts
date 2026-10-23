import { ArcCacheDO } from "@arctools/arc-data/cloudflare";
import { manifestHash } from "@arctools/discord/server";
import { TwitchAccount, TwitchEnrollment } from "@arctools/twitch/server";
import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Website, websiteDevelopment } from "../../../stacks/website.js";
import { BotApi } from "./api.js";
import { bindOrigin, buildRevision, runtimeConfig } from "./config.js";
import { ingressHandlers } from "./ingress.js";
import { operatorHandlers } from "./operator.js";
import { Tenants } from "./tenant-contracts.js";
import { TenantBoundaryObserver } from "./tenant-diagnostics.js";
import { bindTenants } from "./tenant.js";
import { bindAccount, bindEnrollment } from "./twitch.js";
import {
  forwardViteSocket,
  forwardWebsite,
  isWebsiteRequest,
} from "./website.js";

export class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-bot-${stage}`,
      main: import.meta.url,
      workersDev: true,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: false },
      },
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const config = yield* runtimeConfig;
    const { identity, operatorSecret } = config;
    const origin = yield* bindOrigin;

    const website =
      identity.kind === "test"
        ? null
        : yield* Effect.gen(function* () {
            const site = yield* Website;

            const fetch = yield* Cloudflare.Workers.Fetch(site).pipe(
              Effect.provide(Cloudflare.Workers.FetchBinding),
            );

            const developmentUrl = yield* Output.named(
              Output.all(websiteDevelopment, site.url).pipe(
                Output.map(([dev, url]) => (dev ? (url ?? "") : "")),
              ),
              "ARC_WEBSITE_DEV_URL",
            );

            return { fetch, developmentUrl };
          });

    const websiteHttp = yield* HttpClient.HttpClient.pipe(
      Effect.provide(FetchHttpClient.layer),
    );

    const testComposition =
      identity.kind === "test" && identity.stage.startsWith("test-tenant-")
        ? yield* Effect.promise(
            () => import("../../../tests/cloud/bot-composition.js"),
          )
        : null;

    const bindings = testComposition
      ? yield* testComposition.botTestBindings(identity)
      : Layer.empty;

    const revision = yield* buildRevision;
    const hash = yield* manifestHash;
    yield* ArcCacheDO.pipe(Effect.provide(bindings));
    const client = yield* bindAccount.pipe(Effect.provide(bindings));

    const enrollmentClient = yield* bindEnrollment.pipe(
      Effect.provide(bindings),
    );

    const tenantClient = yield* bindTenants.pipe(Effect.provide(bindings));

    return {
      fetch: Effect.gen(function* () {
        const receivedAt = Date.now();
        const observation = testComposition?.botRequestObservation(identity);

        const response = yield* Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          const pathname = new URL(request.url, "https://bot.internal")
            .pathname;

          const localUrl = website ? yield* website.developmentUrl : "";

          if (
            website &&
            isWebsiteRequest(request.method, pathname, localUrl !== "")
          ) {
            if (
              localUrl &&
              request.headers.upgrade?.toLowerCase() === "websocket"
            )
              return yield* forwardViteSocket(localUrl, request).pipe(
                Effect.provideService(HttpClient.HttpClient, websiteHttp),
                Effect.catchTag("HttpClientError", () =>
                  Effect.succeed(
                    HttpServerResponse.empty({
                      status: 503,
                      headers: { "Cache-Control": "no-store" },
                    }),
                  ),
                ),
              );

            return yield* forwardWebsite(
              (assetRequest) =>
                Effect.gen(function* () {
                  const url = new URL(assetRequest.url);

                  if (localUrl)
                    return yield* websiteHttp.execute(
                      HttpClientRequest.setUrl(
                        assetRequest,
                        new URL(`${url.pathname}${url.search}`, localUrl).href,
                      ),
                    );

                  return yield* website.fetch(assetRequest);
                }),
              request,
              localUrl !== "",
            );
          }

          const account = yield* client;
          const enrollment = yield* enrollmentClient;

          const tenants = yield* observation
            ? tenantClient.pipe(
                Effect.provideService(
                  TenantBoundaryObserver,
                  observation.observer,
                ),
              )
            : tenantClient;

          const callback = `${yield* origin}/webhooks/twitch`;

          const handler = yield* HttpApiBuilder.layer(BotApi).pipe(
            Layer.provide(
              HttpApiBuilder.group(BotApi, "health", (handlers) =>
                handlers.handle("health", () =>
                  Effect.succeed({
                    status: "ready",
                    stage: identity.stage,
                    revision,
                    manifestHash: hash,
                  }),
                ),
              ),
            ),
            Layer.provide(
              operatorHandlers(identity.stage, operatorSecret).pipe(
                Layer.provide(Layer.succeed(TwitchAccount, account)),
                Layer.provide(Layer.succeed(TwitchEnrollment, enrollment)),
              ),
            ),
            Layer.provide(
              ingressHandlers({ ...config, callback, receivedAt }).pipe(
                Layer.provide(Layer.succeed(TwitchAccount, account)),
                Layer.provide(Layer.succeed(Tenants, tenants)),
              ),
            ),
            Layer.provide(HttpRouter.disableLogger),
            Layer.provide(
              Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true),
            ),
            Layer.provide(HttpServer.layerServices),
            HttpRouter.toHttpEffect,
          );

          return yield* handler;
        });

        return yield* Effect.succeed(response).pipe(
          Effect.map((response) =>
            observation
              ? HttpServerResponse.setHeaders(response, observation.headers())
              : response,
          ),
          Effect.map((response) =>
            HttpServerResponse.setHeader(
              response,
              "x-arc-ingress-ms",
              String(Date.now() - receivedAt),
            ),
          ),
        );
      }),
    };
  }),
) {}

export default Bot;
