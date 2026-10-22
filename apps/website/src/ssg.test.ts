import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";
import { Window } from "happy-dom";
import { expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = { ...process.env };

delete env.VITEST;

const built = spawnSync("bun", ["run", "build"], {
  cwd: root,
  encoding: "utf8",
  env,
  maxBuffer: 10 * 1024 * 1024,
});

const Manifest = Schema.Struct({
  client: Schema.String,
  prerendered: Schema.Array(Schema.String),
});

const manifestPath = path.join(root, "dist/server/foldkit.build.json");

const manifest = Effect.runSync(
  Schema.decodeUnknownEffect(Manifest)(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  ),
);

const clientDirectory = path.join(root, manifest.client);

const pageFile = (route: string) =>
  route === "/"
    ? path.join(clientDirectory, "index.html")
    : path.join(clientDirectory, route.slice(1), "index.html");

const readPage = (route: string) => readFileSync(pageFile(route), "utf8");

const documentOf = (html: string) => {
  const window = new Window();
  window.document.write(html);

  return window.document;
};

test("static generation writes the public pages", () => {
  expect(built.status, built.stderr).toBe(0);
  expect(manifest.prerendered).toEqual(["/", "/connect"]);
});

test("homepage HTML is the raid-ready page before its script", () => {
  const html = readPage("/");
  const scriptAt = html.indexOf("<script");
  const document = documentOf(html);

  expect(scriptAt).toBeGreaterThan(html.indexOf("Your chat."));
  expect(document.title).toBe("ARC Tools · Your chat, raid ready.");
  expect(document.body.textContent).toContain(
    "Less alt-tabbing. More raiding.",
  );
  expect(html).not.toContain("/oauth/twitch/enroll/status");
  expect(html).toContain('href="/connect"');
  expect(html).not.toContain('href="/assets/connect"');
  expect(document.body.textContent).not.toContain("Getting your status");
});

test("connect HTML is the generic loading shell before its script", () => {
  const html = readPage("/connect");
  const scriptAt = html.indexOf("<script");
  const document = documentOf(html);

  expect(scriptAt).toBeGreaterThan(html.indexOf("Your channel connection."));
  expect(document.title).toBe("Connection status · ARC Tools");
  expect(document.body.textContent).toContain(
    "Checking the connection session in this browser.",
  );
  expect(document.body.textContent).not.toContain("You're raid ready.");
  expect(html).not.toContain("/oauth/twitch/enroll/status");
});

test("both pages share the build identity and the emitted stylesheet", () => {
  const home = documentOf(readPage("/"));
  const connect = documentOf(readPage("/connect"));
  const homeRoot = home.querySelector("[data-foldkit-build]");
  const connectRoot = connect.querySelector("[data-foldkit-build]");
  const buildId = homeRoot?.getAttribute("data-foldkit-build");
  const script = home.querySelector("script[type='module']");

  const stylesheet = home.querySelector(
    "link[rel='stylesheet'][href^='/assets/']",
  );

  const scriptSrc = script?.getAttribute("src");

  const stylesheetHref = stylesheet?.getAttribute("href");

  expect(buildId).toBeTruthy();
  expect(connectRoot?.getAttribute("data-foldkit-build")).toBe(buildId);
  expect(homeRoot?.getAttribute("data-foldkit-app")).toBeTruthy();
  expect(scriptSrc?.startsWith("/")).toBe(true);
  expect(stylesheetHref?.startsWith("/")).toBe(true);

  expect(scriptSrc).toBeTruthy();
  expect(stylesheetHref).toBeTruthy();

  const scriptText = readFileSync(
    path.join(clientDirectory, (scriptSrc ?? "").slice(1)),
    "utf8",
  );

  const cssText = readFileSync(
    path.join(clientDirectory, (stylesheetHref ?? "").slice(1)),
    "utf8",
  );

  const documentClass = home.documentElement.className;

  const bodyClass = home.body.className;

  expect(scriptText).toContain(buildId);
  expect(connect.documentElement.className).toBe(documentClass);
  expect(connect.body.className).toBe(bodyClass);
  expect(documentClass.split(/\s+/).filter(Boolean).length).toBeGreaterThan(0);

  for (const token of `${documentClass} ${bodyClass}`.split(/\s+/)) {
    if (token !== "") expect(cssText).toContain(`.${token}`);
  }

  expect(
    home.querySelector("meta[name='description']")?.getAttribute("content"),
  ).toContain("ARC Raiders");
  expect(
    home.querySelector("link[href*='fonts.googleapis.com']"),
  ).not.toBeNull();
});
