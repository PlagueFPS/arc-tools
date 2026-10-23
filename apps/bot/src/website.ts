import { Effect } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

const isDevelopmentAsset = (pathname: string) =>
  ["/@vite/client", "/@react-refresh", "/@tanstack-start/styles.css"].includes(
    pathname,
  ) ||
  ["/src/", "/node_modules/", "/@id/", "/@fs/"].some((prefix) =>
    pathname.startsWith(prefix),
  );

export const isWebsiteRequest = (
  method: string,
  pathname: string,
  development = false,
) =>
  (method === "GET" || method === "HEAD") &&
  (pathname === "/" ||
    pathname === "/connect" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/") ||
    (development && isDevelopmentAsset(pathname)));

export const forwardViteSocket = Effect.fnUntraced(function* (
  origin: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  const incoming = new URL(request.url, "https://website.internal");

  if (
    request.method !== "GET" ||
    incoming.pathname !== "/" ||
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    request.headers["sec-websocket-protocol"] !== "vite-hmr"
  )
    return HttpServerResponse.empty({ status: 404 });

  const target = new URL("/", origin);
  const token = incoming.searchParams.get("token");

  if (token !== null) target.searchParams.set("token", token);

  const transport = yield* FetchHttpClient.Fetch;
  let upgradeResponse: Response | undefined;

  const response = yield* HttpClient.get(target, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": "vite-hmr",
      // Vite checks its websocket token only when Origin is present.
      Origin: target.origin,
    },
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // Effect's client response hides the native Cloudflare websocket upgrade.
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(
        async (input: Parameters<typeof transport>[0], init?: RequestInit) => {
          const native = await transport(input, init);

          if (native.status === 101) upgradeResponse = native;

          return native;
        },
        { preconnect: transport.preconnect },
      ),
    ),
  );

  if (response.status !== 101)
    return HttpServerResponse.fromClientResponse(response);

  if (!upgradeResponse)
    return yield* new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request: response.request,
        response,
        description: "Vite upgrade requires a native FetchHttpClient response",
      }),
    });

  // Consume the empty HTTP body to release HttpClient's abort-on-GC registration.
  yield* response.arrayBuffer;

  return HttpServerResponse.raw(upgradeResponse, { status: 101 });
});

export const forwardWebsite = Effect.fnUntraced(
  function* <E, R>(
    fetchAsset: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
    request: HttpServerRequest.HttpServerRequest,
    development = false,
  ) {
    const url = new URL(request.url, "https://website.internal");

    if (!isWebsiteRequest(request.method, url.pathname, development))
      return HttpServerResponse.empty({ status: 404 });

    const pathname = url.pathname;

    const target = new URL(pathname, "https://website.internal");

    if (
      development &&
      (pathname.startsWith("/assets/") || isDevelopmentAsset(pathname))
    ) {
      const query: string[] = [];

      for (const key of [
        "v",
        "t",
        "import",
        "direct",
        "html-proxy",
        "index",
        "url",
        "routes",
        "tsr-split",
      ]) {
        const value = url.searchParams.get(key);

        if (value !== null) {
          query.push(
            value === "" ? key : `${key}=${encodeURIComponent(value)}`,
          );
        }
      }

      target.search = query.join("&");
    }

    const assetRequest = HttpClientRequest.make(request.method)(target.href);

    const response = yield* fetchAsset(
      development && request.headers.accept?.includes("text/css")
        ? HttpClientRequest.setHeader(assetRequest, "accept", "text/css")
        : assetRequest,
    );

    if (response.status >= 300 && response.status < 400)
      return HttpServerResponse.empty({ status: 404 });

    return HttpServerResponse.fromClientResponse(response);
  },
  (effect) =>
    effect.pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.text("Website temporarily unavailable", {
            status: 503,
            headers: { "Cache-Control": "no-store" },
          }),
        ),
      ),
    ),
);
