import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Command, Dom, Http } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";

import { CheckError, EnrollmentStatus, RequestId } from "./domain/enrollment";
import { Message } from "./message";

export const checkEnrollment = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/oauth/twitch/enroll/status");

  if (response.status === 401) {
    return yield* Effect.fail(CheckError.Absent());
  }

  if (response.status !== 200) {
    return yield* Effect.fail(CheckError.Unavailable());
  }

  return yield* Schema.decodeUnknownEffect(EnrollmentStatus)(
    yield* response.json,
  );
});

export const CheckEnrollment = Command.define("CheckEnrollment", {
  args: { requestId: RequestId },
  messages: [Message.SucceededCheckEnrollment, Message.FailedCheckEnrollment],
  execute: ({ requestId }) =>
    checkEnrollment().pipe(
      Effect.timeout("12 seconds"),
      Effect.match({
        onSuccess: (status) =>
          Message.SucceededCheckEnrollment({ requestId, status }),
        onFailure: (error) =>
          Message.FailedCheckEnrollment({
            requestId,
            error: Schema.is(CheckError)(error)
              ? error
              : CheckError.Unavailable(),
          }),
      }),
      Effect.provide(Http.layer),
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    ),
});

export const ScrollToContent = Command.define("ScrollToContent", {
  args: { hash: Schema.String },
  messages: [Message.CompletedScrollToContent],
  execute: ({ hash }) =>
    Effect.gen(function* () {
      const target = `#${CSS.escape(hash)}`;

      yield* Dom.scrollIntoViewAfterPaint(target, { block: "start" });
      yield* Dom.focus(target, { preventScroll: true, makeFocusable: true });
    }).pipe(Effect.ignore, Effect.as(Message.CompletedScrollToContent())),
});

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});
