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

const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

const connectRouter = pipe(literal("connect"), Route.mapTo(AppRoute.Connect));

// Vite publishes `base` with a trailing slash. Public routes stay `/` and
// `/connect`. Development serves those documents under `/assets/` so the bot
// can proxy the dev server, and the same prefix has to come off when parsing
// and go back on when printing. Production and preview use `/`.
export const applicationBase = (base: string): string => {
  if (base === "" || base === "/" || base === "./") return "";

  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;

  return normalized.startsWith("/") ? normalized : "";
};

export const stripApplicationBase = (
  pathname: string,
  base: string,
): string => {
  const prefix = applicationBase(base);

  if (prefix === "") return pathname;

  if (pathname === prefix || pathname === `${prefix}/`) return "/";

  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);

  return pathname;
};

export const prefixApplicationBase = (path: string, base: string): string => {
  const prefix = applicationBase(base);

  if (prefix === "") return path;

  if (path === "/") return `${prefix}/`;

  return path.startsWith("/") ? `${prefix}${path}` : path;
};

const configuredBase = () => import.meta.env.BASE_URL;

const parseRoute = Route.parseUrlWithFallback(
  Route.oneOf(connectRouter, homeRouter),
  AppRoute.NotFound,
);

export const urlToAppRoute = (url: Url): AppRoute =>
  parseRoute({
    ...url,
    pathname: stripApplicationBase(url.pathname, configuredBase()),
  });

export const homeHref = (): string =>
  prefixApplicationBase(homeRouter(), configuredBase());

export const connectHref = (): string =>
  prefixApplicationBase(connectRouter(), configuredBase());

export const enrollmentPath = "/oauth/twitch/enroll";
