import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";
import type { Url } from "foldkit/url";

export const ApplicationRoute = defineRouteUnion({
  Home: {},
  Connect: {},
  NotFound: { path: Schema.String },
});

export type ApplicationRoute = typeof ApplicationRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(ApplicationRoute.Home));

export const connectRouter = pipe(
  literal("connect"),
  Route.mapTo(ApplicationRoute.Connect),
);

export const urlToApplicationRoute: (url: Url) => ApplicationRoute =
  Route.parseUrlWithFallback(
    Route.oneOf(connectRouter, homeRouter),
    ApplicationRoute.NotFound,
  );

export const enrollmentPath = "/oauth/twitch/enroll";
