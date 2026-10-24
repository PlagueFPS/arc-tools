import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";
import type { Url } from "foldkit/url";

export const AppRoute = defineRouteUnion({
  Home: {},
  Connect: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

export const connectRouter = pipe(
  literal("connect"),
  Route.mapTo(AppRoute.Connect),
);

export const urlToAppRoute: (url: Url) => AppRoute = Route.parseUrlWithFallback(
  Route.oneOf(connectRouter, homeRouter),
  AppRoute.NotFound,
);

export const enrollmentPath = "/oauth/twitch/enroll";
