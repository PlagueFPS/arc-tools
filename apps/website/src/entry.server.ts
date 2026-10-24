import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import * as Url from "foldkit/url";

import { init, view } from "./main";
import { AppRoute, urlToAppRoute } from "./route";
import { enrollmentResponse } from "./server/routes.js";

export const prerenderPaths = ["/", "/connect"];

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
  Server.renderDocument(application, assets, {
    head: '<meta name="description" content="ARC Raiders answers, right in Twitch chat. Connect your channel to ARC Tools for item, crafting, and event commands."><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#130918"><script>document.documentElement.classList.add("dark")</script>',
  });

const render = Effect.fnUntraced(function* (request: Request) {
  const response = yield* enrollmentResponse(request);

  if (response) return Server.Responded(response);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Server.Responded(
      new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  }

  const url = Option.getOrThrow(Url.fromString(request.url));

  const application = yield* Server.renderToString(
    { routing: {}, init, view },
    { url: request.url },
  );

  return Server.Rendered(application, {
    status: AppRoute.guards.NotFound(urlToAppRoute(url)) ? 404 : 200,
  });
});

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(render(request));
