import { decodeBody, digest, readJson, request } from "@arctools/utils/http";
import {
  Predicate,
  Clock,
  Duration,
  Effect,
  Redacted,
  Schedule,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  canonicalManifest,
  commandManifest,
  manifestHash,
  RemoteCommands,
} from "./manifest.js";

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
  code: Schema.Literals([
    "provider",
    "stale-release",
    "readback",
    "rate-limit",
  ]),
  phase: Schema.Literals(["before", "overwrite", "after"]),
}) {}

export const ReleaseHealth = Schema.Struct({
  status: Schema.Literal("ready"),
  stage: Schema.String,
  revision: Schema.String,
  manifestHash: Schema.String,
});

export interface Release {
  readonly stage: string;
  readonly revision: string;
  readonly endpoint: string;
  readonly applicationId: string;
  readonly token: Redacted.Redacted<string>;
}

export const RetryAfter = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
).pipe(
  Schema.decodeTo(
    Schema.Duration.check(
      Schema.makeFilter(Duration.isFinite),
      Schema.makeFilter(Duration.isGreaterThan(Duration.zero)),
    ),
    SchemaTransformation.transform({
      decode: (seconds) => Duration.millis(Math.ceil(seconds * 1000)),
      encode: Duration.toSeconds,
    }),
  ),
);

class DiscordRateLimited extends Schema.TaggedError<DiscordRateLimited>()(
  "DiscordRateLimited",
  { delay: Schema.Duration },
) {}

const readHealth = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  endpoint: string,
) {
  return yield* request(
    client,
    HttpClientRequest.get(`${endpoint.replace(/\/$/, "")}/health`),
    Effect.fnUntraced(function* (response) {
      const body = yield* HttpClientResponse.matchStatus(response, {
        "2xx": readJson,
        429: readJson,
        orElse: () => Effect.succeed(null),
      });

      return {
        status: response.status,
        health: yield* decodeBody(ReleaseHealth)(body),
      };
    }),
  );
});

export const waitForRelease = Effect.fn("Discord.waitForRelease")(function* (
  release: Pick<Release, "stage" | "revision" | "endpoint">,
  wait = false,
) {
  const client = yield* HttpClient.HttpClient;
  const hash = yield* manifestHash;

  return yield* readHealth(client, release.endpoint).pipe(
    Effect.map(
      ({ status, health }) =>
        status === 200 &&
        health.stage === release.stage &&
        health.revision === release.revision &&
        health.manifestHash === hash,
    ),
    Effect.catch(() => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced(1000).pipe(
        Schedule.upTo({ times: wait ? 59 : 0 }),
      ),
      until: (ready) => ready,
    }),
  );
});

export const syncCommands = Effect.fn("Discord.sync")(function* (
  release: Release,
  options: {
    readonly api?: string;
    readonly desired?: RemoteCommands;
    readonly checkOnly?: boolean;
  } = {},
) {
  const client = yield* HttpClient.HttpClient;

  const discord = client.pipe(
    HttpClient.mapRequest((outgoing) =>
      outgoing.pipe(
        HttpClientRequest.prependUrl(
          options.api ?? "https://discord.com/api/v10",
        ),
        HttpClientRequest.setHeader(
          "Authorization",
          `Bot ${Redacted.value(release.token)}`,
        ),
      ),
    ),
  );

  const desired = options.desired ?? commandManifest;

  const hash = options.desired
    ? yield* digest(canonicalManifest(desired))
    : yield* manifestHash;

  const fence = Effect.fnUntraced(
    function* (phase: "before" | "overwrite" | "after") {
      const { status, health } = yield* readHealth(client, release.endpoint);

      if (
        status !== 200 ||
        health.stage !== release.stage ||
        health.revision !== release.revision ||
        health.manifestHash !== hash
      )
        return yield* new SyncError({ code: "stale-release", phase });
    },
    (effect, phase) =>
      effect.pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "SyncError")
            ? error
            : new SyncError({ code: "provider", phase }),
        ),
      ),
  );

  const call = Effect.fnUntraced(
    function* (method: "GET" | "PUT", phase: "before" | "overwrite" | "after") {
      const end = (yield* Clock.currentTimeMillis) + 30_000;

      const attempt = Effect.fnUntraced(
        function* () {
          yield* fence(phase);

          return yield* request(
            discord,
            HttpClientRequest.make(method)(
              `/applications/${encodeURIComponent(release.applicationId)}/commands`,
            ).pipe(
              method === "PUT"
                ? HttpClientRequest.bodyJsonUnsafe(desired)
                : HttpClientRequest.setUrlParam("with_localizations", "true"),
            ),
            Effect.fnUntraced(function* (response) {
              const body = yield* HttpClientResponse.matchStatus(response, {
                "2xx": readJson,
                429: readJson,
                orElse: () => Effect.succeed(null),
              });

              return yield* HttpClientResponse.matchStatus(response, {
                200: () => decodeBody(RemoteCommands)(body),
                429: Effect.fnUntraced(function* () {
                  const retry = yield* decodeBody(
                    Schema.Struct({ retry_after: Schema.Number }),
                  )(body);

                  const delay = yield* Schema.decodeUnknownEffect(RetryAfter)(
                    retry.retry_after,
                  ).pipe(
                    Effect.mapError(
                      () => new SyncError({ code: "rate-limit", phase }),
                    ),
                  );

                  if (
                    (yield* Clock.currentTimeMillis) +
                      Duration.toMillis(delay) >=
                    end
                  )
                    return yield* new SyncError({ code: "rate-limit", phase });

                  return yield* new DiscordRateLimited({ delay });
                }),
                orElse: () => new SyncError({ code: "provider", phase }),
              });
            }),
          );
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((error) =>
              Predicate.isTagged(error, "SyncError") ||
              Predicate.isTagged(error, "DiscordRateLimited")
                ? error
                : new SyncError({ code: "provider", phase }),
            ),
          ),
      );

      return yield* attempt().pipe(
        Effect.retry({
          while: Predicate.isTagged("DiscordRateLimited"),
          schedule: Schedule.recurs(3).pipe(
            Schedule.addDelay(
              ({
                input,
              }: Schedule.Metadata<number, SyncError | DiscordRateLimited>) =>
                Effect.succeed(
                  Predicate.isTagged(input, "DiscordRateLimited")
                    ? input.delay
                    : Duration.zero,
                ),
            ),
          ),
        }),
        Effect.catchTag(
          "DiscordRateLimited",
          () => new SyncError({ code: "rate-limit", phase }),
        ),
      );
    },
    (effect, _method, phase) =>
      effect.pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "SyncError")
            ? error
            : new SyncError({ code: "provider", phase }),
        ),
      ),
  );

  const remote = yield* call("GET", "before");
  const drift = canonicalManifest(remote) !== canonicalManifest(desired);

  if (options.checkOnly) return { changed: false, drift, hash };

  if (drift) {
    yield* call("PUT", "overwrite");
    const readback = yield* call("GET", "after");

    if (canonicalManifest(readback) !== canonicalManifest(desired))
      return yield* new SyncError({ code: "readback", phase: "after" });
  }

  yield* fence("after");

  return { changed: drift, drift: false, hash };
});
