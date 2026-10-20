import {
  Predicate,
  Clock,
  Duration,
  Effect,
  Redacted,
  Schema,
  SchemaTransformation,
} from "effect";

import {
  canonicalManifest,
  commandManifest,
  manifestHash,
  RemoteCommands,
} from "./discord-manifest.js";
import { decodeBody, digest, request } from "./provider-http.js";

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

export const syncCommands = Effect.fn("Discord.sync")(function* (
  release: Release,
  options: {
    readonly api?: string;
    readonly desired?: RemoteCommands;
    readonly checkOnly?: boolean;
  } = {},
) {
  const desired = options.desired ?? commandManifest;

  const hash = options.desired
    ? yield* digest(canonicalManifest(desired))
    : yield* manifestHash;

  const fence = Effect.fnUntraced(
    function* (phase: "before" | "overwrite" | "after") {
      const result = yield* request(
        `${release.endpoint.replace(/\/$/, "")}/health`,
        {},
      );

      const health = yield* decodeBody(ReleaseHealth)(result.body);

      if (
        result.status !== 200 ||
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

      for (let attempt = 0; attempt < 4; attempt++) {
        yield* fence(phase);

        const response = yield* request(
          `${options.api ?? "https://discord.com/api/v10"}/applications/${encodeURIComponent(release.applicationId)}/commands${method === "GET" ? "?with_localizations=true" : ""}`,
          {
            method,
            headers: {
              Authorization: `Bot ${Redacted.value(release.token)}`,
              "Content-Type": "application/json",
            },
            body: method === "PUT" ? JSON.stringify(desired) : undefined,
          },
        );

        if (response.status === 429) {
          const retry = yield* decodeBody(
            Schema.Struct({ retry_after: Schema.Number }),
          )(response.body);

          const delay = yield* Schema.decodeUnknownEffect(RetryAfter)(
            retry.retry_after,
          ).pipe(
            Effect.mapError(() => new SyncError({ code: "rate-limit", phase })),
          );

          if (
            (yield* Clock.currentTimeMillis) + Duration.toMillis(delay) >=
              end ||
            attempt === 3
          )
            return yield* new SyncError({ code: "rate-limit", phase });
          yield* Effect.sleep(delay);
          continue;
        }

        if (response.status !== 200)
          return yield* new SyncError({ code: "provider", phase });

        return yield* decodeBody(RemoteCommands)(response.body);
      }

      return yield* new SyncError({ code: "rate-limit", phase });
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
