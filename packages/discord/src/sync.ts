import { digest } from "@arctools/utils/http";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Predicate,
  Redacted,
  Schema,
  SchemaTransformation,
  Schedule,
  Stream,
  String as Str,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  canonicalManifest,
  commandManifest,
  manifestHash,
  RemoteCommands,
} from "./manifest.js";

const Phase = Schema.Literals(["before", "overwrite", "after"]);

const Operation = Schema.Literals([
  "health",
  "read",
  "overwrite",
  "readback",
  "preflight",
]);

export class SyncError extends Schema.TaggedError<
  SyncError,
  { readonly brand: unique symbol }
>()("SyncError", {
  code: Schema.Literals([
    "provider",
    "network",
    "body",
    "deadline",
    "stale-release",
    "readback",
    "rate-limit",
  ]),
  phase: Phase,
  operation: Operation,
  attempt: Schema.Int,
  status: Schema.NullOr(Schema.Int),
  discordCode: Schema.NullOr(Schema.Int),
}) {}

export const syncDiagnostic = (error: SyncError) => ({
  event: "discord-sync-failure",
  code: error.code,
  operation: error.operation,
  phase: error.phase,
  attempt: error.attempt,
  retryCount: error.attempt - 1,
  status: error.status,
  discordCode: error.discordCode,
});

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

class Retryable extends Schema.TaggedError<
  Retryable,
  { readonly brand: unique symbol }
>()("DiscordRetryable", {
  failure: SyncError,
  delay: Schema.NullOr(Schema.Duration),
}) {}

interface Attempt {
  readonly phase: typeof Phase.Type;
  readonly operation: typeof Operation.Type;
  readonly attempt: number;
  readonly deadline: number;
}

const failure = (
  context: Attempt,
  code: SyncError["code"],
  status: number | null = null,
  discordCode: number | null = null,
) =>
  new SyncError({
    phase: context.phase,
    operation: context.operation,
    attempt: context.attempt,
    code,
    status,
    discordCode,
  });

const retryable = (error: SyncError, delay: Duration.Duration | null = null) =>
  new Retryable({ failure: error, delay });

const readBody = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  context: Attempt,
) {
  const bytes = yield* response.stream.pipe(
    Stream.catchReason("HttpClientError", "EmptyBodyError", () => Stream.empty),
    Stream.mapError((): SyncError | Retryable =>
      retryable(failure(context, "network", response.status)),
    ),
    Stream.limitBytes(256 * 1024, () =>
      Stream.fail<SyncError | Retryable>(
        failure(context, "body", response.status),
      ),
    ),
    Stream.mkUint8Array,
  );

  if (bytes.byteLength === 0) return null;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
    new TextDecoder().decode(bytes),
  ).pipe(Effect.mapError(() => failure(context, "body", response.status)));
});

const call = Effect.fnUntraced(function* <A, I>(
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, I>,
  context: Attempt,
) {
  const remaining = context.deadline - (yield* Clock.currentTimeMillis);

  if (remaining <= 0) return yield* failure(context, "deadline");

  let receivedStatus: number | null = null;

  return yield* HttpClient.withScope(client)
    .pipe(HttpClient.filterStatus((status) => status === 200))
    .execute(request)
    .pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* (response) {
          receivedStatus = response.status;
          const body = yield* readBody(response, context);

          return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError(() => failure(context, "body", response.status)),
          );
        }),
      ),
      Effect.catchReason(
        "HttpClientError",
        "StatusCodeError",
        Effect.fnUntraced(function* ({ response }) {
          receivedStatus = response.status;

          const body = yield* readBody(response, context).pipe(
            Effect.orElseSucceed(() => null),
          );

          const discordCode =
            context.operation === "health"
              ? null
              : Option.getOrNull(
                  Option.map(
                    Schema.decodeUnknownOption(
                      Schema.Struct({ code: Schema.Int }),
                    )(body),
                    ({ code }) => code,
                  ),
                );

          if (response.status === 429) {
            const parsed = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ retry_after: RetryAfter }),
            )(body).pipe(
              Effect.mapError(() =>
                failure(context, "rate-limit", 429, discordCode),
              ),
            );

            return yield* retryable(
              failure(context, "rate-limit", 429, discordCode),
              parsed.retry_after,
            );
          }

          const error = failure(
            context,
            "provider",
            response.status,
            discordCode,
          );

          if ([500, 502, 503, 504].includes(response.status))
            return yield* retryable(error);

          return yield* error;
        }),
      ),
      Effect.catchTag("HttpClientError", () =>
        retryable(failure(context, "network")),
      ),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Math.min(4000, remaining),
        orElse: (): Effect.Effect<never, SyncError | Retryable> => {
          if (receivedStatus === 429)
            return failure(context, "rate-limit", receivedStatus);

          if (
            receivedStatus !== null &&
            receivedStatus !== 200 &&
            ![500, 502, 503, 504].includes(receivedStatus)
          )
            return failure(context, "provider", receivedStatus);

          return retryable(failure(context, "deadline", receivedStatus));
        },
      }),
    );
});

const withRetries = Effect.fnUntraced(function* <A, R>(
  action: (
    attempt: number,
    deadline: number,
  ) => Effect.Effect<A, SyncError | Retryable, R>,
  retries = 3,
  budgetMs = 30_000,
) {
  const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
  let attempt = 0;

  return yield* Effect.suspend(() => action(++attempt, deadline)).pipe(
    Effect.retry({
      while: Predicate.isTagged("DiscordRetryable"),
      schedule: Schedule.exponential(250).pipe(
        Schedule.upTo({ times: retries }),
        Schedule.modifyDelay(
          Effect.fnUntraced(function* ({
            input,
            duration,
          }: Schedule.Metadata<Duration.Duration, SyncError | Retryable>) {
            if (!Predicate.isTagged(input, "DiscordRetryable")) return duration;
            const { failure: error } = input;
            const delay = input.delay ?? duration;

            if (
              (yield* Clock.currentTimeMillis) + Duration.toMillis(delay) >=
              deadline
            )
              return yield* error;
            yield* Effect.logWarning({
              ...syncDiagnostic(error),
              event: "discord-sync-retry",
              delayMs: Duration.toMillis(delay),
            });

            return delay;
          }),
        ),
      ),
    }),
    Effect.catchTag("DiscordRetryable", ({ failure }) => failure),
  );
});

const readHealth = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  release: Pick<Release, "stage" | "revision" | "endpoint">,
  hash: string,
  phase: typeof Phase.Type,
  attempt: number,
  deadline: number,
) {
  const context = {
    operation: "health",
    phase,
    attempt,
    deadline,
  } satisfies Attempt;

  const health = yield* call(
    client,
    HttpClientRequest.get(`${Str.replace(/\/$/, "")(release.endpoint)}/health`),
    ReleaseHealth,
    context,
  );

  if (
    health.stage !== release.stage ||
    health.revision !== release.revision ||
    health.manifestHash !== hash
  )
    return yield* failure(context, "stale-release", 200);
});

export const waitForRelease = Effect.fn("Discord.waitForRelease")(function* (
  release: Pick<Release, "stage" | "revision" | "endpoint">,
  wait = false,
) {
  const client = yield* HttpClient.HttpClient;
  const hash = yield* manifestHash;

  return yield* withRetries(
    (attempt, deadline) =>
      readHealth(client, release, hash, "before", attempt, deadline).pipe(
        Effect.mapError((error) => {
          const cause = Predicate.isTagged(error, "DiscordRetryable")
            ? error.failure
            : error;

          if (cause.code === "rate-limit") return error;

          if (cause.status !== null && [400, 401, 403].includes(cause.status))
            return cause;

          return retryable(cause, Duration.seconds(1));
        }),
      ),
    wait ? 59 : 0,
    wait ? 60_000 : 4000,
  );
});

const discordClient = (
  client: HttpClient.HttpClient,
  release: Pick<Release, "applicationId" | "token">,
  api: string,
) =>
  client.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(api),
        HttpClientRequest.setHeader(
          "Authorization",
          `Bot ${Redacted.value(release.token)}`,
        ),
      ),
    ),
  );

const commandsPath = (release: Pick<Release, "applicationId">) =>
  `/applications/${encodeURIComponent(release.applicationId)}/commands`;

export const preflightCommands = Effect.fn("Discord.preflight")(function* (
  release: Pick<Release, "applicationId" | "token">,
  options: { readonly api?: string } = {},
) {
  const client = discordClient(
    yield* HttpClient.HttpClient,
    release,
    options.api ?? "https://discord.com/api/v10",
  );

  yield* withRetries((attempt, deadline) =>
    call(
      client,
      HttpClientRequest.get(commandsPath(release)).pipe(
        HttpClientRequest.setUrlParam("with_localizations", "true"),
      ),
      RemoteCommands,
      { operation: "preflight", phase: "before", attempt, deadline },
    ),
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

  const discord = discordClient(
    client,
    release,
    options.api ?? "https://discord.com/api/v10",
  );

  const desired = options.desired ?? commandManifest;

  const hash = options.desired
    ? yield* digest(canonicalManifest(desired))
    : yield* manifestHash;

  let changed = false;

  return yield* withRetries(
    Effect.fnUntraced(function* (attempt, deadline) {
      const command = Effect.fnUntraced(function* (
        operation: "read" | "overwrite" | "readback",
        phase: typeof Phase.Type,
      ) {
        yield* readHealth(client, release, hash, phase, attempt, deadline);

        return yield* call(
          discord,
          operation === "overwrite"
            ? HttpClientRequest.put(commandsPath(release)).pipe(
                HttpClientRequest.bodyJsonUnsafe(desired),
              )
            : HttpClientRequest.get(commandsPath(release)).pipe(
                HttpClientRequest.setUrlParam("with_localizations", "true"),
              ),
          RemoteCommands,
          { operation, phase, attempt, deadline },
        );
      });

      const remote = yield* command("read", "before");
      const drift = canonicalManifest(remote) !== canonicalManifest(desired);

      if (options.checkOnly) return { changed: false, drift, hash };

      if (drift) {
        changed = true;
        yield* command("overwrite", "overwrite");
        const readback = yield* command("readback", "after");

        if (canonicalManifest(readback) !== canonicalManifest(desired))
          return yield* failure(
            { operation: "readback", phase: "after", attempt, deadline },
            "readback",
            200,
          );
      }

      yield* readHealth(client, release, hash, "after", attempt, deadline);

      return { changed, drift: false, hash };
    }),
  );
});
