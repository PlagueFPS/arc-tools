import {
  Cause,
  Exit,
  Clock,
  Effect,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";

export const fixtureHeader = "x-arc-cloud-fixture";

export const fixtureRequestMs = 20000;

const placeholderSha256 =
  "2000e6b28a1517ba1268e1649cd3163326ef839492edfdba31e8959830580976";

const disposableHost =
  /^arc-tools-(?:probe|cache|metaforge|account|provider|bot|tenant)-test-(?:foundation|cache|account|tenant)-[a-f0-9]{8}-[a-f0-9]{12}\.[a-z0-9-]+\.workers\.dev$/;

const errorNames = [
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "FetchError",
  "SystemError",
  "unknown",
] as const;

const networkCodes = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "unknown",
] as const;

const transientCodes = new Set<string>([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const CauseLink = Schema.Struct({
  name: Schema.Literals(errorNames),
  code: Schema.Literals(networkCodes),
});

const property = (cause: unknown, key: string) => {
  try {
    return Predicate.hasProperty(cause, key) ? cause[key] : undefined;
  } catch {
    return undefined;
  }
};

export const sanitizeTransportCause = (
  cause: unknown,
): ReadonlyArray<typeof CauseLink.Type> => {
  const links: (typeof CauseLink.Type)[] = [];
  const seen = new Set<unknown>();

  for (
    let current = cause;
    current !== undefined && links.length < 3 && !seen.has(current);
    current = property(current, "cause")
  ) {
    seen.add(current);
    links.push({
      name: Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Literals(errorNames))(
          property(current, "name"),
        ),
        () => "unknown" as const,
      ),
      code: Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Literals(networkCodes))(
          property(current, "code"),
        ),
        () => "unknown" as const,
      ),
    });
  }

  return links;
};

const ContextFields = {
  operationId: Schema.String,
  attemptId: Schema.String,
  attempt: Schema.Int,
  method: Schema.String,
  route: Schema.String,
  elapsedMs: Schema.Number,
};

const TenantDiagnostic = Schema.Struct({
  lookups: Schema.NullOr(Schema.String),
  rpcs: Schema.NullOr(Schema.String),
  phase: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  admissionDeltaMs: Schema.NullOr(Schema.String),
  cutoff: Schema.NullOr(Schema.String),
  activation: Schema.NullOr(Schema.String),
  fallback: Schema.NullOr(Schema.String),
  fallbackCode: Schema.NullOr(Schema.String),
});

const HttpDiagnostic = Schema.Struct({
  ...ContextFields,
  kind: Schema.Literal("http"),
  status: Schema.Number,
  contentType: Schema.NullOr(Schema.String),
  server: Schema.NullOr(Schema.String),
  ray: Schema.NullOr(Schema.String),
  fixture: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Number,
  bodySha256: Schema.String,
  probeError: Schema.optional(Schema.Literal("fixture-failure")),
  tenant: TenantDiagnostic,
});

export const RequestDiagnostic = Schema.Union([
  HttpDiagnostic,
  Schema.Struct({
    ...ContextFields,
    kind: Schema.Literal("cleanup"),
    controlId: Schema.String,
    state: Schema.Literals(["confirmed", "dirty", "unknown"]),
    releaseResponseLost: Schema.Boolean,
  }),
  Schema.Struct({
    ...ContextFields,
    kind: Schema.Literals(["transport", "body-read"]),
    causes: Schema.Array(CauseLink),
  }),
  Schema.Struct({
    ...ContextFields,
    kind: Schema.Literal("decode"),
    code: Schema.Literals(["status", "content-type", "json", "schema"]),
  }),
  Schema.Struct({
    ...ContextFields,
    kind: Schema.Literal("budget"),
    budgetMs: Schema.Number,
  }),
]);

export class FixtureRequestError extends Schema.TaggedError<FixtureRequestError>()(
  "FixtureRequestError",
  { diagnostic: RequestDiagnostic },
) {
  override get message() {
    return JSON.stringify(this.diagnostic);
  }
}

class FixtureRouteNotReady extends Schema.TaggedError<FixtureRouteNotReady>()(
  "FixtureRouteNotReady",
  { diagnostic: HttpDiagnostic },
) {}

export type EvidenceSink = (
  event: typeof RequestDiagnostic.Type,
) => Effect.Effect<void>;

let evidenceSink: EvidenceSink = (event) =>
  Effect.sync(() => console.info(JSON.stringify({ fixtureHttp: event })));

export const setFixtureHttpEvidenceSink = (sink: EvidenceSink) => {
  evidenceSink = sink;
};

export const isRouteNotReady = (
  url: URL,
  diagnostic: Pick<
    typeof HttpDiagnostic.Type,
    "status" | "contentType" | "server" | "fixture" | "bodySha256"
  >,
) =>
  url.protocol === "https:" &&
  disposableHost.test(url.hostname) &&
  diagnostic.status === 404 &&
  diagnostic.contentType?.split(";")[0] === "text/html" &&
  diagnostic.server === "cloudflare" &&
  diagnostic.fixture === null &&
  diagnostic.bodySha256 === placeholderSha256;

const paths = new Set([
  "snapshot",
  "control",
  "observations",
  "setup",
  "status",
  "complete",
  "dispatch",
  "observe",
  "time",
  "configure",
  "reconstruct",
  "credential",
  "prepare",
  "attribution",
  "read",
  "clear",
  "arm",
  "native-alarm",
  "alarm",
  "accept",
  "recover",
  "source",
  "discord",
  "health",
  "token",
  "validate",
  "users",
  "eventsub",
  "subscriptions",
  "chat",
  "messages",
  "commands",
  "fixture-discord",
  "webhooks",
  "twitch",
  "oauth",
  "helix",
  "ops",
  "interactions",
  "applications",
  "release",
  "temporary",
  "activate",
  "retire",
  "state",
  "items",
  "arcs",
  "traders",
  "events-schedule",
]);

export const safeRoute = (url: URL) => {
  const segments = url.pathname.split("/");

  const mapped = segments.map((part, index) => {
    if (!part) return "";

    if (segments[index - 1] === "journeys") return ":journey";

    if (part === "journeys") return part;

    return paths.has(part) ? part : ":value";
  });

  return `${disposableHost.test(url.hostname) ? `${url.hostname.split(".")[0]}.*.workers.dev` : "external"}${mapped.join("/")}`;
};

const safeHeader = (headers: Headers, key: string, pattern: RegExp) => {
  const value = headers.get(key);

  return value !== null && pattern.test(value) ? value : null;
};

const numeric = /^-?\d{1,16}$/;

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

const codes =
  /^(?:ok|none|accepted|committed|uncommitted|rpc-entry|duplicate|input|conflict|capacity|success|command-error|command-defect|recorded|missing|wait-limit|replayed|computing|delivering|terminal|sent|expired|ambiguous|rejected|retryable|private|deadline|overloaded|unavailable|interrupted|superseded|schema|status|parse|timeout|source|data|internal|admission|transport|not-found|invalid|failure|unknown|cache|error|worker|ingress-budget|rpc-timeout|rpc-defect|rpc-failure)$/;

const fallbackHeader = (headers: Headers, key: string) =>
  headers.has(key) ? (safeHeader(headers, key, codes) ?? "unknown") : null;

const SafeObservationTypeId: unique symbol = Symbol("SafeObservation");

export interface SafeObservation<A, I = unknown> {
  readonly [SafeObservationTypeId]: true;
  readonly url: string;
  readonly schema: Schema.Codec<A, I>;
}

export type ObservationKind =
  | "provider"
  | "native-account"
  | "attribution"
  | "tenant"
  | "cache"
  | "source"
  | "control";

export const auditedObservation = <A, I>(
  kind: ObservationKind,
  url: string,
  schema: Schema.Codec<A, I>,
): SafeObservation<A, I> => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/journeys\/[a-z][a-z0-9-]{0,63}/, "");

  const fixture = disposableHost.test(parsed.hostname)
    ? /^arc-tools-(provider|account|tenant|cache|metaforge)-test-/.exec(
        parsed.hostname,
      )?.[1]
    : new Map([
        ["provider.invalid", "provider"],
        ["account.invalid", "account"],
        ["tenant.invalid", "tenant"],
        ["cache.invalid", "cache"],
        ["source.invalid", "metaforge"],
      ]).get(parsed.hostname);

  const valid = {
    provider: fixture === "provider" && path === "/snapshot",
    "native-account":
      fixture === "account" && path === "/native-alarm/snapshot",
    attribution: fixture === "account" && path === "/attribution",
    tenant: fixture === "tenant" && path === "/snapshot",
    cache: fixture === "cache" && path === "/snapshot",
    source: fixture === "metaforge" && path === "/observations",
    control:
      (fixture === "provider" || fixture === "metaforge") &&
      path === "/temporary/state",
  }[kind];

  if (!valid) throw new Error("Unaudited fixture observation");

  return { [SafeObservationTypeId]: true, url, schema };
};

export const makeFixtureHttp = (
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  sink: EvidenceSink = (event) => evidenceSink(event),
) => {
  const retainFailure = <
    A,
    E extends FixtureRequestError | FixtureRouteNotReady,
    R,
  >(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;

        return Effect.forEach(
          exit.cause.reasons,
          (reason) =>
            Cause.isFailReason(reason)
              ? sink(reason.error.diagnostic)
              : Effect.void,
          { discard: true },
        );
      }),
    );

  const metadata = new WeakMap<
    Response,
    Omit<typeof HttpDiagnostic.Type, "kind">
  >();

  const context = (
    url: string,
    method = "GET",
    operationId = crypto.randomUUID(),
    attempt = 1,
  ) => ({
    operationId,
    attemptId: crypto.randomUUID(),
    attempt,
    method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)
      ? method
      : "unknown",
    route: safeRoute(new URL(url)),
    elapsedMs: 0,
  });

  const runWire = Effect.fnUntraced(function* (
    url: string,
    init: RequestInit,
    ctx: ReturnType<typeof context>,
    budgetMs: number,
  ) {
    const clock = yield* Clock.Clock;
    const started = clock.monotonicTimeNanosUnsafe();

    const current = () => ({
      ...ctx,
      elapsedMs: Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6,
    });

    const failTransport = (kind: "transport" | "body-read", cause: unknown) =>
      new FixtureRequestError({
        diagnostic: {
          ...current(),
          kind,
          causes: sanitizeTransportCause(cause),
        },
      });

    const decoded = yield* Effect.tryPromise({
      try: async (parentSignal) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        parentSignal.addEventListener("abort", abort, { once: true });
        let timedOut = false;

        const timer = setTimeout(
          () => {
            timedOut = true;
            controller.abort();
          },
          Math.max(1, budgetMs),
        );

        let response: Response | undefined;

        try {
          const aborted = new Promise<never>((_resolve, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(new DOMException("", "TimeoutError")),
              { once: true },
            ),
          );

          try {
            response = await Promise.race([
              fetcher(url, {
                ...init,
                redirect: "manual",
                signal: controller.signal,
              }),
              aborted,
            ]);
          } catch (error) {
            throw timedOut
              ? new FixtureRequestError({
                  diagnostic: { ...current(), kind: "budget", budgetMs },
                })
              : failTransport("transport", error);
          }

          let body: ArrayBuffer;

          try {
            body = await Promise.race([
              response.clone().arrayBuffer(),
              aborted,
            ]);
          } catch (error) {
            void response.body?.cancel().catch(() => {});
            throw timedOut
              ? new FixtureRequestError({
                  diagnostic: { ...current(), kind: "budget", budgetMs },
                })
              : failTransport("body-read", error);
          }

          const digest = await Promise.race([
            crypto.subtle.digest("SHA-256", body),
            aborted,
          ]);

          return { response, body, digest };
        } finally {
          clearTimeout(timer);
          parentSignal.removeEventListener("abort", abort);
        }
      },
      catch: (error) =>
        Schema.is(FixtureRequestError)(error)
          ? error
          : failTransport("transport", error),
    }).pipe(retainFailure);

    const { response, body, digest } = decoded;
    const probe = new URL(url);

    const probeError =
      ctx.method === "GET" &&
      probe.pathname === "/snapshot" &&
      probe.hostname.startsWith("arc-tools-probe-test-") &&
      disposableHost.test(probe.hostname) &&
      response.status === 500 &&
      response.headers.get(fixtureHeader) === "v1" &&
      body.byteLength <= 8192 &&
      Option.isSome(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(
            Schema.Struct({ probeError: Schema.Literal("fixture-failure") }),
          ),
        )(new TextDecoder().decode(body)),
      )
        ? ("fixture-failure" as const)
        : undefined;

    const diagnostic: typeof HttpDiagnostic.Type = {
      ...current(),
      kind: "http",
      status: response.status,
      probeError,
      contentType: safeHeader(
        response.headers,
        "content-type",
        /^(?:application\/(?:json|octet-stream)|text\/(?:html|plain))(?:; ?charset=(?:UTF-8|utf-8))?$/,
      ),
      server: safeHeader(
        response.headers,
        "server",
        /^(?:cloudflare|workerd)$/,
      ),
      ray: safeHeader(response.headers, "cf-ray", /^[a-f0-9]{16}-[A-Z]{3}$/),
      fixture: safeHeader(response.headers, fixtureHeader, /^v1$/),
      bodyBytes: body.byteLength,
      bodySha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
      tenant: {
        lookups: safeHeader(response.headers, "x-arc-tenant-lookups", numeric),
        rpcs: safeHeader(response.headers, "x-arc-tenant-rpcs", numeric),
        phase: safeHeader(response.headers, "x-arc-tenant-phase", codes),
        code: safeHeader(response.headers, "x-arc-tenant-code", codes),
        admissionDeltaMs: safeHeader(
          response.headers,
          "x-arc-admission-delta-ms",
          numeric,
        ),
        cutoff: safeHeader(response.headers, "x-arc-tenant-cutoff", numeric),
        activation: safeHeader(
          response.headers,
          "x-arc-tenant-activation",
          uuid,
        ),
        fallback: fallbackHeader(response.headers, "x-arc-command-fallback"),
        fallbackCode: fallbackHeader(response.headers, "x-arc-command-code"),
      },
    };

    if (
      response.headers.get(fixtureHeader) === null &&
      isRouteNotReady(new URL(url), diagnostic)
    )
      return yield* new FixtureRouteNotReady({ diagnostic }).pipe(
        retainFailure,
      );

    if (!response.ok)
      return yield* new FixtureRequestError({ diagnostic }).pipe(retainFailure);
    yield* sink(diagnostic);
    metadata.set(response, diagnostic);

    return response;
  });

  const request = Effect.fnUntraced(function* (
    url: string,
    init: RequestInit = {},
  ) {
    const clock = yield* Clock.Clock;
    const start = clock.monotonicTimeNanosUnsafe();
    const id = crypto.randomUUID();

    for (let attempt = 1; ; attempt++) {
      const remaining =
        fixtureRequestMs -
        Number(clock.monotonicTimeNanosUnsafe() - start) / 1e6;

      const ctx = context(url, init.method, id, attempt);

      if (remaining <= 0)
        return yield* new FixtureRequestError({
          diagnostic: {
            ...ctx,
            elapsedMs: fixtureRequestMs - remaining,
            kind: "budget",
            budgetMs: fixtureRequestMs,
          },
        });

      const result = yield* runWire(url, init, ctx, remaining).pipe(
        Effect.exit,
      );

      if (Exit.isSuccess(result)) return result.value;
      const reason = result.cause.reasons[0];

      if (
        result.cause.reasons.length !== 1 ||
        !reason ||
        !Cause.isFailReason(reason) ||
        !Predicate.isTagged(reason.error, "FixtureRouteNotReady") ||
        attempt >= 16
      )
        return yield* Effect.failCause(
          Cause.map(
            result.cause,
            (error) =>
              new FixtureRequestError({ diagnostic: error.diagnostic }),
          ),
        );

      yield* Effect.sleep(Math.min(1000, remaining));
    }
  });

  const post = (url: string, body?: Schema.Json) =>
    request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const json = Effect.fnUntraced(function* <A, I>(
    response: Response,
    schema: Schema.Codec<A, I>,
  ) {
    const ctx =
      metadata.get(response) ?? context("https://external.invalid/unknown");

    const decodeFailure = (
      code: "status" | "content-type" | "json" | "schema",
    ) =>
      new FixtureRequestError({
        diagnostic: { ...ctx, kind: "decode", code },
      });

    if (response.status !== 200) return yield* decodeFailure("status");

    if (
      response.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return yield* decodeFailure("content-type");

    const value = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => decodeFailure("json"),
    });

    return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => decodeFailure("schema")),
    );
  }, retainFailure);

  const get = Effect.fnUntraced(function* <A, I>(
    url: string,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* json(yield* request(url), schema);
  });

  const observe = Effect.fnUntraced(function* <A, I>(
    observation: SafeObservation<A, I>,
    options: {
      readonly until: (value: A) => boolean;
      readonly budgetMs: number;
    },
  ) {
    const clock = yield* Clock.Clock;
    const start = clock.monotonicTimeNanosUnsafe();
    const id = crypto.randomUUID();
    let wireAttempt = 0;

    const remaining = () =>
      options.budgetMs - Number(clock.monotonicTimeNanosUnsafe() - start) / 1e6;

    const budget = () =>
      new FixtureRequestError({
        diagnostic: {
          ...context(observation.url, "GET", id, wireAttempt),
          kind: "budget",
          elapsedMs: options.budgetMs - remaining(),
          budgetMs: options.budgetMs,
        },
      });

    for (;;) {
      let value: Option.Option<A> = Option.none();

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (remaining() <= 0) return yield* budget();
        wireAttempt++;

        const result = yield* runWire(
          observation.url,
          {},
          context(observation.url, "GET", id, wireAttempt),
          Math.min(fixtureRequestMs, remaining()),
        ).pipe(Effect.exit);

        if (Exit.isSuccess(result)) {
          value = Option.some(yield* json(result.value, observation.schema));
          break;
        }

        const reason = result.cause.reasons[0];

        if (
          result.cause.reasons.length !== 1 ||
          !reason ||
          !Cause.isFailReason(reason)
        )
          return yield* Effect.failCause(
            Cause.map(
              result.cause,
              (error) =>
                new FixtureRequestError({ diagnostic: error.diagnostic }),
            ),
          );
        const failure = reason.error;

        const retry =
          Predicate.isTagged(failure, "FixtureRouteNotReady") ||
          ((failure.diagnostic.kind === "transport" ||
            failure.diagnostic.kind === "body-read") &&
            failure.diagnostic.causes.some((link) =>
              transientCodes.has(link.code),
            ));

        if (!retry || attempt === 3)
          return yield* new FixtureRequestError({
            diagnostic: failure.diagnostic,
          });
        yield* Effect.sleep(Math.min(attempt * 100, Math.max(0, remaining())));
      }

      if (remaining() <= 0) return yield* budget();

      if (Option.isSome(value) && options.until(value.value))
        return value.value;
      yield* Effect.sleep(Math.min(100, Math.max(0, remaining())));
    }
  });

  const requestOnce = (url: string, init: RequestInit, budgetMs: number) =>
    runWire(url, init, context(url, init.method), budgetMs).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(
            cause,
            (error) =>
              new FixtureRequestError({ diagnostic: error.diagnostic }),
          ),
        ),
      ),
    );

  const recordCleanup = (
    url: string,
    controlId: string,
    state: "confirmed" | "dirty" | "unknown",
    releaseResponseLost: boolean,
  ) =>
    sink({
      ...context(url),
      kind: "cleanup",
      controlId,
      state,
      releaseResponseLost,
    });

  const responseMetadata = (response: Response) => metadata.get(response);

  return {
    request,
    post,
    get,
    json,
    observe,
    requestOnce,
    recordCleanup,
    responseMetadata,
  };
};

export const fixtureHttp = makeFixtureHttp();

export const { request, post, get, json, observe, responseMetadata } =
  fixtureHttp;

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
