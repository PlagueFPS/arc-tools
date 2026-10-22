import { Option } from "effect";
import { fromString } from "foldkit/url";
import { expect, test } from "vitest";

import {
  AppRoute,
  connectHref,
  homeHref,
  prefixApplicationBase,
  stripApplicationBase,
  urlToAppRoute,
} from "./route";

const url = (pathname: string) =>
  Option.getOrThrow(fromString(`https://bot.invalid${pathname}`));

test("the configured base round-trips the public routes", () => {
  const base = import.meta.env.BASE_URL;
  const home = prefixApplicationBase("/", base);
  const connect = prefixApplicationBase("/connect", base);
  const missing = prefixApplicationBase("/missing", base);
  const missingRoute = urlToAppRoute(url(missing));

  expect(homeHref()).toBe(home);
  expect(connectHref()).toBe(connect);
  expect(stripApplicationBase(home, base)).toBe("/");
  expect(stripApplicationBase(connect, base)).toBe("/connect");
  expect(AppRoute.guards.Home(urlToAppRoute(url(home)))).toBe(true);
  expect(AppRoute.guards.Connect(urlToAppRoute(url(connect)))).toBe(true);
  expect(AppRoute.guards.NotFound(missingRoute) && missingRoute.path).toBe(
    "/missing",
  );
});

test("the dev server base and the public paths name the same pages", () => {
  const base = "/assets/";

  expect(stripApplicationBase("/assets/", base)).toBe("/");
  expect(stripApplicationBase("/assets", base)).toBe("/");
  expect(stripApplicationBase("/assets/connect", base)).toBe("/connect");
  expect(stripApplicationBase("/", base)).toBe("/");
  expect(stripApplicationBase("/connect", base)).toBe("/connect");
  expect(prefixApplicationBase("/", base)).toBe("/assets/");
  expect(prefixApplicationBase("/connect", base)).toBe("/assets/connect");
  expect(prefixApplicationBase("/connect", "/")).toBe("/connect");
});
