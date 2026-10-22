import { Effect } from "effect";
import { Server } from "foldkit/experimental";

import { bodyClass, documentClass } from "./documentStyle";
import { init, view } from "./main";

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

const siteHead = [
  '<meta name="theme-color" content="#151517">',
  '<meta name="description" content="ARC Raiders answers, right in Twitch chat. Connect your channel to ARC Tools for item, crafting, and event commands.">',
  '<meta name="referrer" content="no-referrer">',
  `<link rel="stylesheet" href="${escapeAttribute("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap")}">`,
].join("");

const assetLinks = (hrefs: ReadonlyArray<string>, rel: string) =>
  hrefs
    .map(
      (href) =>
        `<link rel="${rel}" crossorigin href="${escapeAttribute(href)}">`,
    )
    .join("");

export const renderDocument = (
  application: Server.RenderedApplication,
  assets: Server.DocumentAssets,
): string => {
  const template = [
    "<!doctype html>",
    `<html lang="en" class="${escapeAttribute(documentClass)}">`,
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title></title>",
    siteHead,
    assetLinks(assets.modulePreloads, "modulepreload"),
    assetLinks(assets.stylesheets, "stylesheet"),
    "</head>",
    `<body class="${escapeAttribute(bodyClass)}">`,
    '<div id="root"></div>',
    `<script type="module" crossorigin src="${escapeAttribute(assets.entryScript)}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");

  return Server.injectIntoTemplate(template, application);
};

export const prerenderPaths: ReadonlyArray<string> = ["/", "/connect"];

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Server.renderToString(
      { routing: {}, init, view },
      { url: request.url },
    ).pipe(Effect.map(Server.Rendered)),
  );
