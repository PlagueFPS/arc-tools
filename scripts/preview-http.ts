import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CheckedPreview,
  type PreviewIdentity,
  PreviewOutput,
  PullRequest,
} from "./preview-identity.js";

const marker = "<!-- arc-tools-synthetic-preview -->";

const healthMismatch =
  "Preview health did not match the exact stage and checked merge revision";

const Comments = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    body: Schema.NullOr(Schema.String),
    user: Schema.Struct({ login: Schema.String }),
  }),
);

const Health = Schema.Struct({
  status: Schema.Literal("ready"),
  stage: PreviewOutput.fields.stage,
  revision: CheckedPreview.fields.revision,
});

export class PreviewHttpError extends Schema.TaggedError<PreviewHttpError>()(
  "PreviewHttpError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const makePreviewHttp = Effect.fnUntraced(function* (options: {
  preview: PreviewIdentity;
  token: Redacted.Redacted<string>;
  githubOrigin?: string;
}) {
  const transport = yield* HttpClient.HttpClient;

  const client = transport.pipe(
    HttpClient.withScope,
    HttpClient.filterStatus((status) => status >= 200 && status < 300),
  );

  const github = client.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(
          `${options.githubOrigin ?? "https://api.github.com"}/repos/${options.preview.repository}`,
        ),
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${Redacted.value(options.token)}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        }),
      ),
    ),
  );

  const api = Effect.fnUntraced(function* <S extends Schema.Constraint>(
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) {
    return yield* github.execute(request).pipe(
      Effect.flatMap((response) => response.text),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.toCodecJson(schema)),
        ),
      ),
      Effect.scoped,
      Effect.timeout(30_000),
      Effect.catchReason(
        "HttpClientError",
        "StatusCodeError",
        ({ response }) =>
          new PreviewHttpError({
            message: `GitHub ${request.method} ${request.url}: HTTP ${response.status}`,
            cause: response.status,
          }),
      ),
    );
  });

  const readPr = () =>
    api(HttpClientRequest.get(`pulls/${options.preview.number}`), PullRequest);

  const healthAttempt = Effect.fnUntraced(
    function* (url: string, checked: CheckedPreview) {
      const value = yield* client
        .get(`${url}/health`)
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)));

      if (
        value.stage !== options.preview.stage ||
        value.revision !== checked.revision
      )
        return yield* new PreviewHttpError({
          message: healthMismatch,
          cause: value,
        });
    },
    (effect) => effect.pipe(Effect.scoped, Effect.timeout(10_000)),
  );

  const health = (url: string, checked: CheckedPreview) =>
    healthAttempt(url, checked).pipe(
      Effect.retry(
        Schedule.recurs(59).pipe(Schedule.addDelay(() => Effect.succeed(1000))),
      ),
      Effect.mapError(
        (cause) => new PreviewHttpError({ message: healthMismatch, cause }),
      ),
    );

  const publish = Effect.fnUntraced(function* (body: string) {
    let existing: number | undefined;

    for (let page = 1; ; page++) {
      const comments = yield* api(
        HttpClientRequest.get(
          `issues/${options.preview.number}/comments?per_page=100&page=${page}`,
        ),
        Comments,
      );

      existing = comments.find(
        (comment) =>
          comment.user.login === "github-actions[bot]" &&
          comment.body?.includes(marker),
      )?.id;

      if (existing || comments.length < 100) break;
    }

    yield* api(
      HttpClientRequest.make(existing ? "PATCH" : "POST")(
        existing
          ? `issues/comments/${existing}`
          : `issues/${options.preview.number}/comments`,
      ).pipe(HttpClientRequest.bodyJsonUnsafe({ body: `${marker}\n${body}` })),
      Schema.Unknown,
    );
  });

  return { readPr, health, publish };
});

export type PreviewHttp = Effect.Success<ReturnType<typeof makePreviewHttp>>;
