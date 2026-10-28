import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Dom, Http } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";

import { ApplicationDefinition } from "./definition";
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

export const CheckEnrollment = ApplicationDefinition.makeCommand(
  "CheckEnrollment",
  {
    args: { requestId: RequestId },
    interrupt: {
      keyFields: ["requestId"],
      toKey: ({ requestId }) => `${requestId}`,
    },
    messages: [Message.SucceededCheckEnrollment, Message.FailedCheckEnrollment],
    handler: function* () {
      return ({ requestId }) =>
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
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The Foldkit Command is the browser request entry point and owns this HTTP layer.
          Effect.provide(Http.layer),
          Effect.provideService(FetchHttpClient.RequestInit, {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
          }),
        );
    },
  },
);

export const leaveChannel = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.post("/oauth/twitch/enroll/leave");

  if (response.status === 401) return yield* Effect.fail(CheckError.Absent());

  if (response.status !== 200)
    return yield* Effect.fail(CheckError.Unavailable());

  const result = yield* Schema.decodeUnknownEffect(EnrollmentStatus)(
    yield* response.json,
  );

  if (result.kind !== "left")
    return yield* Effect.fail(CheckError.Unavailable());

  return result;
});

export const LeaveChannel = ApplicationDefinition.makeCommand("LeaveChannel", {
  args: { requestId: RequestId },
  interrupt: {
    keyFields: ["requestId"],
    toKey: ({ requestId }) => `${requestId}`,
  },
  messages: [Message.SucceededLeaveChannel, Message.FailedLeaveChannel],
  handler: function* () {
    return ({ requestId }) =>
      leaveChannel().pipe(
        Effect.timeout("12 seconds"),
        Effect.match({
          onSuccess: (status) =>
            Message.SucceededLeaveChannel({ requestId, status }),
          onFailure: (error) =>
            Message.FailedLeaveChannel({
              requestId,
              error: Schema.is(CheckError)(error)
                ? error
                : CheckError.Unavailable(),
            }),
        }),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The Foldkit Command is the browser request entry point and owns this HTTP layer.
        Effect.provide(Http.layer),
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        }),
      );
  },
});

export const ScrollToContent = ApplicationDefinition.makeCommand(
  "ScrollToContent",
  {
    args: { hash: Schema.String },
    messages: [Message.CompletedScrollToContent],
    handler: function* () {
      return ({ hash }) =>
        Effect.gen(function* () {
          const target = `#${CSS.escape(hash)}`;

          yield* Dom.scrollIntoViewAfterPaint(target, { block: "start" });
          yield* Dom.focus(target, {
            preventScroll: true,
            makeFocusable: true,
          });
        }).pipe(Effect.ignore, Effect.as(Message.CompletedScrollToContent()));
    },
  },
);

export const NavigateInternal = ApplicationDefinition.makeCommand(
  "NavigateInternal",
  {
    args: { url: Schema.String },
    messages: [Message.CompletedNavigateInternal],
    handler: function* () {
      return ({ url }) =>
        pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal()));
    },
  },
);

export const LoadExternal = ApplicationDefinition.makeCommand("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  handler: function* () {
    return ({ href }) =>
      load(href).pipe(Effect.as(Message.CompletedLoadExternal()));
  },
});

export const EffectsLayer = Layer.mergeAll(
  CheckEnrollment.layer,
  LeaveChannel.layer,
  ScrollToContent.layer,
  NavigateInternal.layer,
  LoadExternal.layer,
);
