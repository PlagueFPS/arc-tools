import { Effect, Schedule, Schema } from "effect";

export const fixtureHeader = "x-arc-cloud-fixture";
const placeholderSha256 =
  "2000e6b28a1517ba1268e1649cd3163326ef839492edfdba31e8959830580976";
const Diagnostic = Schema.Struct({
  method: Schema.String,
  route: Schema.String,
  status: Schema.Number,
  contentType: Schema.NullOr(Schema.String),
  server: Schema.NullOr(Schema.String),
  ray: Schema.NullOr(Schema.String),
  fixture: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Number,
  bodySha256: Schema.String,
});
export class FixtureHttpError extends Schema.TaggedError<FixtureHttpError>()(
  "FixtureHttpError",
  { message: Schema.String, diagnostic: Diagnostic },
) {}
class FixtureRouteNotReady extends Schema.TaggedError<FixtureRouteNotReady>()(
  "FixtureRouteNotReady",
  { diagnostic: Diagnostic },
) {}

export const isRouteNotReady = (url: URL, diagnostic: typeof Diagnostic.Type) =>
  url.protocol === "https:" &&
  /^arc-tools-(?:probe|cache|metaforge|account|provider|bot|tenant)-test-(?:foundation|cache|account|tenant)-[a-f0-9]{8}-[a-f0-9]{12}\.[a-z0-9-]+\.workers\.dev$/.test(
    url.hostname,
  ) &&
  diagnostic.status === 404 &&
  diagnostic.contentType?.split(";")[0] === "text/html" &&
  diagnostic.server === "cloudflare" &&
  diagnostic.fixture === null &&
  diagnostic.bodySha256 === placeholderSha256;

export const makeFixtureHttp = (
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) => {
  const request = Effect.fnUntraced(
    function* (url: string, init: RequestInit = {}) {
      const parsed = new URL(url);
      const method = init.method ?? "GET";
      const route = `${parsed.hostname}${parsed.pathname}`;
      const response = yield* Effect.tryPromise({
        try: (signal) => fetcher(url, { ...init, redirect: "manual", signal }),
        catch: () =>
          new Error(
            `Fixture transport failed for ${method} ${route}; execution unknown, not retried`,
          ),
      });
      const body = yield* Effect.tryPromise({
        try: () => response.clone().arrayBuffer(),
        catch: () =>
          new Error(
            `Fixture body read failed for ${method} ${route}; execution unknown, not retried`,
          ),
      });
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", body),
      );
      const diagnostic = {
        method,
        route,
        status: response.status,
        contentType: response.headers.get("content-type"),
        server: response.headers.get("server"),
        ray: response.headers.get("cf-ray"),
        fixture: response.headers.get(fixtureHeader),
        bodyBytes: body.byteLength,
        bodySha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
      const routeNotReady = isRouteNotReady(parsed, diagnostic);
      console.info(
        JSON.stringify({
          fixtureHttp: routeNotReady ? "route-not-ready" : "response",
          ...diagnostic,
        }),
      );
      if (routeNotReady) return yield* new FixtureRouteNotReady({ diagnostic });
      if (!response.ok)
        return yield* new FixtureHttpError({
          message: "Unexpected fixture HTTP status; not retried",
          diagnostic,
        });
      return response;
    },
    (effect) =>
      effect.pipe(
        Effect.retry({
          while: (error) => error instanceof FixtureRouteNotReady,
          times: 15,
          schedule: Schedule.spaced("1 second"),
        }),
        Effect.timeout("20 seconds"),
      ),
  );
  const post = (url: string, body?: unknown) =>
    request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const json = Effect.fnUntraced(function* <A, I>(
    response: Response,
    schema: Schema.Codec<A, I>,
  ) {
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(
          `Fixture JSON expected status 200, received ${response.status}; not retried`,
        ),
      );
    }
    if (
      response.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return yield* Effect.fail(
        new Error(
          `Fixture JSON content-type mismatch at status ${response.status}; not retried`,
        ),
      );
    }
    const value: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new Error(
          `Malformed fixture JSON at status ${response.status}; body omitted, not retried`,
        ),
    });
    return yield* Schema.decodeUnknownEffect(schema)(value);
  });
  const get = Effect.fnUntraced(function* <A, I>(
    url: string,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* json(yield* request(url), schema);
  });
  return { request, post, get, json };
};

export const { request, post, get, json } = makeFixtureHttp();

export const reconstructedSnapshot = Effect.fnUntraced(function* <
  A extends { readonly instance: string },
  E,
  R,
>(read: Effect.Effect<A, E, R>, previous: string) {
  const result = yield* read.pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() =>
        console.info(
          JSON.stringify({
            reconstruction: { previous, observed: snapshot.instance },
          }),
        ),
      ),
    ),
    Effect.repeat({
      until: (snapshot) => snapshot.instance !== previous,
      times: 20,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("5 seconds"),
  );
  if (result.instance === previous)
    return yield* Effect.fail(
      new Error(
        `Reconstruction not observed after 21 snapshots of ${previous}`,
      ),
    );
  return result;
});
