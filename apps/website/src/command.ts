import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Dom, Http, Render } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";

import { ApplicationDefinition } from "./definition";
import { CheckError, EnrollmentStatus, RequestId } from "./domain/enrollment";
import { Message } from "./message";
import {
  StoredTheme,
  Theme,
  themeColor,
  themeStorageKey,
  themeTransitionKey,
} from "./theme";

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

const persistTheme = Effect.fnUntraced(
  function* (theme: Theme) {
    const storage = yield* KeyValueStore.KeyValueStore;
    const encoded = yield* Schema.encodeEffect(StoredTheme)(theme);

    yield* storage.set(themeStorageKey, encoded);
  },
  (effect) => effect.pipe(Effect.ignore),
);

const applyTheme = (theme: Theme) =>
  Effect.sync(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);

    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      meta.content = themeColor[theme];
    }
  });

const restoreTheme = Effect.gen(function* () {
  const storage = yield* KeyValueStore.KeyValueStore;

  const theme = yield* Schema.decodeUnknownEffect(StoredTheme)(
    yield* storage.get(themeStorageKey),
  );

  return Option.some(theme);
}).pipe(Effect.orElseSucceed(() => Option.none<Theme>()));

/**
 * Swaps every color at once. Without the freeze, elements with their own
 * transitions would fade at different speeds and the page would smear. The
 * toggle's icon opts out so it still morphs.
 */
const freezeTransitions = Effect.acquireRelease(
  Effect.sync(() => {
    const style = document.createElement("style");
    style.textContent = `*:not([data-${themeTransitionKey}]),*::before,*::after{transition:none!important}`;
    document.head.appendChild(style);

    return style;
  }),
  (style) =>
    Render.afterPaint.pipe(Effect.andThen(Effect.sync(() => style.remove()))),
);

const setTheme = (theme: Theme) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* freezeTransitions;
      yield* applyTheme(theme);
      // Commit the new colors while transitions are still disabled.
      yield* Effect.sync(
        () => getComputedStyle(document.documentElement).color,
      );
    }),
  );

export const ApplyTheme = ApplicationDefinition.makeCommand("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  handler: function* () {
    return ({ theme }) =>
      setTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme()));
  },
});

export const RestoreTheme = ApplicationDefinition.makeCommand("RestoreTheme", {
  messages: [Message.RestoredTheme],
  handler: function* () {
    return () =>
      restoreTheme.pipe(
        Effect.map((theme) => Message.RestoredTheme({ theme })),
      );
  },
});

export const ToggleTheme = ApplicationDefinition.makeCommand("ToggleTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedToggleTheme],
  handler: function* () {
    return ({ theme }) =>
      setTheme(theme).pipe(
        Effect.andThen(persistTheme(theme)),
        Effect.as(Message.CompletedToggleTheme()),
      );
  },
});

export const EffectsLayer = Layer.mergeAll(
  CheckEnrollment.layer,
  LeaveChannel.layer,
  ScrollToContent.layer,
  NavigateInternal.layer,
  LoadExternal.layer,
  ToggleTheme.layer,
  RestoreTheme.layer,
  ApplyTheme.layer,
);
