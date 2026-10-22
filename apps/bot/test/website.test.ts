import { expect, test } from "bun:test";

import { Context, Effect, Layer, Result } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from "effect/http";

import {
  forwardViteSocket,
  forwardWebsite,
  isWebsiteRequest,
} from "../src/website.js";

for (const path of [
  "/",
  "/connect",
  "/assets/app.js",
  "/assets/app.css",
  "/favicon.ico",
]) {
  test(`only GET and HEAD can forward website path ${path}`, () => {
    expect(isWebsiteRequest("GET", path)).toBe(true);
    expect(isWebsiteRequest("HEAD", path)).toBe(true);
    expect(isWebsiteRequest("POST", path)).toBe(false);
  });
}

for (const path of [
  "/health",
  "/ops/setup",
  "/ops/status",
  "/webhooks/twitch",
  "/interactions/discord",
  "/oauth/twitch/enroll",
  "/oauth/twitch/enroll/status",
  "/oauth/twitch/callback",
  "/missing",
  "/connect/extra",
  "/assets",
]) {
  test(`API or unknown path ${path} stays with Bot routing`, () => {
    expect(isWebsiteRequest("GET", path)).toBe(false);
    expect(isWebsiteRequest("HEAD", path)).toBe(false);
  });
}

for (const method of ["GET", "HEAD"] as const) {
  test(`${method} page forwarding removes cookies, authorization, query, and incoming headers`, async () => {
    const request = HttpServerRequest.fromWeb(
      new Request(
        "https://bot.invalid/connect?code=private-code&state=private-state",
        {
          method,
          headers: {
            cookie: "session=private",
            authorization: "Bearer private",
            "x-private": "private",
            accept: "text/html",
          },
        },
      ),
    );

    const result = await forwardWebsite((assetRequest) => {
      expect(assetRequest.method).toBe(method);
      expect(assetRequest.url).toBe(
        "https://website.internal/connect/index.html",
      );
      expect(assetRequest.headers).toEqual(Headers.empty);
      expect(assetRequest.urlParams).toEqual(UrlParams.empty);

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          assetRequest,
          new Response(method === "HEAD" ? null : "<main>ARC Tools</main>", {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "public, max-age=60",
            },
          }),
        ),
      );
    }, request).pipe(Effect.runPromise);

    const response = HttpServerResponse.toWeb(result);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe(
      method === "HEAD" ? "" : "<main>ARC Tools</main>",
    );
  });
}

test("asset forwarding preserves path, content type, cache headers and missing assets", async () => {
  const result = await forwardWebsite(
    (request) => {
      expect(request.url).toBe("https://website.internal/assets/missing.js");

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("Not found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          }),
        ),
      );
    },
    HttpServerRequest.fromWeb(
      new Request("https://bot.invalid/assets/missing.js?credential=private"),
    ),
  ).pipe(Effect.runPromise);

  expect(result.status).toBe(404);
  expect(result.headers["content-type"]).toBe("text/plain");
});

test("upstream redirects never expose an asset destination and failures return 503", async () => {
  const request = HttpServerRequest.fromWeb(
    new Request("https://bot.invalid/"),
  );

  const redirected = await forwardWebsite(
    (assetRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          assetRequest,
          new Response(null, {
            status: 302,
            headers: { Location: "https://unexpected.invalid" },
          }),
        ),
      ),
    request,
  ).pipe(Effect.runPromise);

  expect(redirected.status).toBe(404);
  expect(redirected.headers.location).toBeUndefined();

  const unavailable = await forwardWebsite(
    () => Effect.fail("asset unavailable"),
    request,
  ).pipe(Effect.runPromise);

  expect(unavailable.status).toBe(503);
  expect(unavailable.headers["cache-control"]).toBe("no-store");
});

test("forwarding declines API and non-GET requests before contacting the asset worker", async () => {
  for (const [method, path] of [
    ["GET", "/health"],
    ["GET", "/oauth/twitch/callback"],
    ["POST", "/connect"],
  ]) {
    const result = await forwardWebsite(
      () => Effect.die("must not contact Website"),
      HttpServerRequest.fromWeb(
        new Request(`https://bot.invalid${path}`, { method }),
      ),
    ).pipe(Effect.runPromise);

    expect(result.status).toBe(404);
  }
});

for (const development of [false, true]) {
  test(`Vite module queries are allowlisted only in development=${development}`, async () => {
    const result = await forwardWebsite(
      (request) => {
        expect(request.url).toBe(
          development
            ? "https://website.internal/assets/index.html?v=version&t=123&import=&direct=&html-proxy=&index=0.js"
            : "https://website.internal/assets/index.html",
        );
        expect(request.headers).toEqual(Headers.empty);

        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("export {}")),
        );
      },
      HttpServerRequest.fromWeb(
        new Request(
          "https://bot.invalid/assets/index.html?v=version&t=123&import&direct&html-proxy&index=0.js&code=private&state=private&token=private",
          { headers: { cookie: "private", authorization: "private" } },
        ),
      ),
      development,
    ).pipe(Effect.runPromise);

    expect(result.status).toBe(200);
  });
}

for (const [development, path, assetPath] of [
  [false, "/", "/index.html"],
  [false, "/connect", "/connect/index.html"],
  [true, "/", "/assets/"],
  [true, "/connect", "/assets/connect"],
] as const) {
  test(`page ${path} forwards to ${assetPath} in development=${development}`, async () => {
    await forwardWebsite(
      (request) => {
        expect(request.url).toBe(`https://website.internal${assetPath}`);
        expect(request.headers).toEqual(Headers.empty);
        expect(request.urlParams).toEqual(UrlParams.empty);

        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("page")),
        );
      },
      HttpServerRequest.fromWeb(
        new Request(`https://bot.invalid${path}?v=version&code=private`, {
          headers: { cookie: "private", authorization: "private" },
        }),
      ),
      development,
    ).pipe(Effect.runPromise);
  });
}

test("Vite sockets reject other paths, methods and protocols before fetching", async () => {
  for (const [method, path, protocol, upgrade] of [
    ["GET", "/oauth/twitch/enroll", "vite-hmr", "websocket"],
    ["GET", "/assets/src/entry.ts", "vite-hmr", "websocket"],
    ["POST", "/assets/", "vite-hmr", "websocket"],
    ["GET", "/assets/", "other-protocol", "websocket"],
    ["GET", "/assets/", "vite-hmr", "other-upgrade"],
  ] as const) {
    const response = await forwardViteSocket(
      "https://must-not-connect.invalid",
      HttpServerRequest.fromWeb(
        new Request(`https://bot.invalid${path}`, {
          method,
          headers: { Upgrade: upgrade, "Sec-WebSocket-Protocol": protocol },
        }),
      ),
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not contact Vite")),
      ),
      Effect.runPromise,
    );

    expect(response.status).toBe(404);
  }
});

test("Vite sockets forward only the Vite token and protocol with an origin for token validation", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/assets/");
      expect(url.search).toBe("?token=vite-token");
      expect(request.headers.get("origin")).toBe(url.origin);
      expect(request.headers.get("upgrade")).toBe("websocket");
      expect(request.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();

      return new Response("Rejected by Vite", { status: 403 });
    },
  });

  try {
    const response = await forwardViteSocket(
      server.url.href,
      HttpServerRequest.fromWeb(
        new Request(
          "https://bot.invalid/assets/?token=vite-token&code=private",
          {
            headers: {
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": "vite-hmr",
              Cookie: "private",
              Authorization: "private",
              Origin: "https://unexpected.invalid",
            },
          },
        ),
      ),
    ).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(response.status).toBe(403);
    expect(await HttpServerResponse.toWeb(response).text()).toBe(
      "Rejected by Vite",
    );
  } finally {
    await server.stop(true);
  }
});

const viteSocketRequest = () =>
  HttpServerRequest.fromWeb(
    new Request("https://bot.invalid/assets/?token=vite-token&code=private", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "vite-hmr",
        Cookie: "private",
        Authorization: "private",
        Origin: "https://unexpected.invalid",
      },
    }),
  );

test("Vite sockets use the injected HttpClient with sanitized requests and manual redirects", async () => {
  let calls = 0;

  const client = HttpClient.make((request, url, _signal, fiber) => {
    calls++;
    expect(request.method).toBe("GET");
    expect(url.href).toBe("https://vite.invalid/assets/?token=vite-token");
    expect(request.headers.origin).toBe("https://vite.invalid");
    expect(request.headers.upgrade).toBe("websocket");
    expect(request.headers["sec-websocket-protocol"]).toBe("vite-hmr");
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(
      Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit),
    ).toEqual({
      redirect: "manual",
    });

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("Injected rejection", { status: 403 }),
      ),
    );
  });

  const response = await forwardViteSocket(
    "https://vite.invalid",
    viteSocketRequest(),
  ).pipe(
    Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Effect.runPromise,
  );

  expect(calls).toBe(1);
  expect(response.status).toBe(403);
  expect(await HttpServerResponse.toWeb(response).text()).toBe(
    "Injected rejection",
  );
});

test("Vite transport rejections remain typed HttpClient failures", async () => {
  const cause = new Error("Vite unavailable");

  const result = await forwardViteSocket(
    "https://vite.invalid",
    viteSocketRequest(),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(() => Promise.reject(cause), {
        preconnect: fetch.preconnect,
      }),
    ),
    Effect.result,
    Effect.runPromise,
  );

  expect(Result.isFailure(result)).toBe(true);

  if (Result.isFailure(result)) {
    expect(HttpClientError.isHttpClientError(result.failure)).toBe(true);
    expect(result.failure.reason._tag).toBe("TransportError");
    expect(result.failure.reason).toHaveProperty("cause", cause);
  }
});

test("Vite redirects are returned without contacting their destination", async () => {
  let redirectsFollowed = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/assets/")
        return new Response(null, {
          status: 302,
          headers: { Location: "/must-not-follow" },
        });
      redirectsFollowed++;

      return new Response("Must not follow");
    },
  });

  try {
    const response = await forwardViteSocket(
      server.url.href,
      viteSocketRequest(),
    ).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/must-not-follow");
    expect(redirectsFollowed).toBe(0);
  } finally {
    await server.stop(true);
  }
});
