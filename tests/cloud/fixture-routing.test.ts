import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, String as Str } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { parseValidationPath } from "./alarm-attribution.js";
import {
  CurrentJourney,
  accountJourney,
  cacheJourney,
  journeyFromName,
  parseJourney,
  routeJourney,
} from "./fixture-routing.js";

const { test } = Test.make({ providers: Layer.empty });

class Api extends HttpApi.make("routing-proof").add(
  HttpApiGroup.make("fixture").add(
    HttpApiEndpoint.get("snapshot", "/snapshot"),
    HttpApiEndpoint.get(
      "validation",
      "/fixture-validation/:instance/:operation/:alarmRun/:invocationId/oauth/validate",
    ),
  ),
) {}

test(
  "journey wrapper strips the prefix before real HttpApi routing and preserves validation attribution",
  Effect.gen(function* () {
    const handler = Effect.gen(function* () {
      const journey = yield* CurrentJourney;
      const request = yield* HttpServerRequest.HttpServerRequest;

      return HttpServerResponse.jsonUnsafe({
        journey,
        path: request.url,
        parsed: parseValidationPath(request.url),
      });
    });

    const handlers = HttpApiBuilder.group(Api, "fixture", (group) =>
      group
        .handleRaw("snapshot", () => handler)
        .handleRaw("validation", () => handler),
    );

    const http = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(handlers),
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
    );

    const call = (path: string) =>
      http.pipe(
        Effect.flatten,
        routeJourney,
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://provider.invalid${path}`),
          ),
        ),
      );

    for (const journey of ["alpha", "beta"]) {
      const response = yield* call(`/journeys/${journey}/snapshot`);
      expect(response.status).toBe(200);
      const web = HttpServerResponse.toWeb(response);
      expect(yield* Effect.promise(() => web.json())).toMatchObject({
        journey,
        path: "/snapshot",
      });
    }

    const instance = "11111111-1111-4111-8111-111111111111";
    const invocation = "22222222-2222-4222-8222-222222222222";

    const response = yield* call(
      `/journeys/alpha/fixture-validation/${instance}/alarm/3/${invocation}/oauth/validate`,
    );

    expect(
      yield* Effect.promise(() => HttpServerResponse.toWeb(response).json()),
    ).toMatchObject({
      journey: "alpha",
      parsed: {
        path: "/oauth/validate",
        correlation: {
          instance,
          invocationId: invocation,
          origin: { operation: "alarm", alarmRun: 3 },
        },
      },
    });

    for (const path of [
      "/snapshot",
      "/journeys//snapshot",
      "/journeys/a%2Fb/snapshot",
      "/journeys/A/snapshot",
      `/journeys/${Str.repeat(65)("a")}/snapshot`,
    ])
      expect((yield* call(path)).status).toBe(400);
  }).pipe(Effect.scoped),
);

test(
  "paired routes and reconstructed native identities cannot silently select shared objects",
  Effect.sync(() => {
    expect(
      accountJourney(
        {
          account: "https://account.invalid",
          provider: "https://provider.invalid",
        },
        "alpha",
      ),
    ).toEqual({
      account: "https://account.invalid/journeys/alpha",
      provider: "https://provider.invalid/journeys/alpha",
    });
    expect(
      cacheJourney(
        { cache: "https://cache.invalid", source: "https://source.invalid" },
        "beta",
      ),
    ).toEqual({
      url: "https://cache.invalid/journeys/beta",
      source: "https://source.invalid/journeys/beta",
    });
    expect(String(journeyFromName("native-alarm:alpha", "native-alarm:"))).toBe(
      "alpha",
    );
    expect(() => journeyFromName(undefined, "environment:")).toThrow(
      "identity unavailable",
    );
    expect(() => journeyFromName("provider", "environment:")).toThrow(
      "identity unavailable",
    );
    expect(
      parseJourney("/journeys/alpha/fixture-validation/a/b/c/d/oauth/validate"),
    ).toMatchObject({
      id: "alpha",
      url: "/fixture-validation/a/b/c/d/oauth/validate",
    });
  }),
);
