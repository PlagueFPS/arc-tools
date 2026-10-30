/* oxlint-disable require-yield -- Foldkit handler recipes require generator constructors even when they capture no Services. */
import { Effect, Layer, Schema } from "effect";
import { Render } from "foldkit";

import { LandingDefinition } from "./definition";
import { Message } from "./message";

class ClipboardUnavailable extends Schema.TaggedError<
  ClipboardUnavailable,
  { readonly brand: unique symbol }
>()("ClipboardUnavailable", {}) {}

export const WaitForReply = LandingDefinition.makeCommand("WaitForReply", {
  args: { text: Schema.String },
  messages: [Message.CompletedWaitForReply],
  handler: function* () {
    return ({ text }: { readonly text: string }) =>
      Effect.sleep("650 millis").pipe(
        Effect.as(Message.CompletedWaitForReply({ text })),
      );
  },
});

export const FollowChat = LandingDefinition.makeCommand("FollowChat", {
  messages: [Message.CompletedFollowChat],
  handler: function* () {
    return () =>
      Render.afterPaint.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const feed = document.getElementById("chat-feed");

            if (feed) feed.scrollTop = feed.scrollHeight;
          }),
        ),
        Effect.as(Message.CompletedFollowChat()),
      );
  },
});

export const CopyCommand = LandingDefinition.makeCommand("CopyCommand", {
  args: { text: Schema.String },
  messages: [Message.SucceededCopyCommand, Message.FailedCopyCommand],
  handler: function* () {
    return ({ text }: { readonly text: string }) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(text),
        catch: () => new ClipboardUnavailable(),
      }).pipe(
        Effect.catchTag("ClipboardUnavailable", () =>
          Effect.try({
            try: () => {
              const previous = document.activeElement;
              const input = document.createElement("textarea");
              input.value = text;
              input.readOnly = true;
              input.style.cssText =
                "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
              document.body.appendChild(input);
              input.select();

              try {
                if (!document.execCommand("copy"))
                  throw new ClipboardUnavailable();
              } finally {
                input.remove();

                if (previous instanceof HTMLElement)
                  previous.focus({ preventScroll: true });
              }
            },
            catch: () => new ClipboardUnavailable(),
          }),
        ),
        Effect.match({
          onSuccess: () => Message.SucceededCopyCommand({ text }),
          onFailure: () => Message.FailedCopyCommand(),
        }),
      );
  },
});

export const WaitBeforeClearCopy = LandingDefinition.makeCommand(
  "WaitBeforeClearCopy",
  {
    args: { text: Schema.String, version: Schema.Int },
    messages: [Message.CompletedWaitBeforeClearCopy],
    handler: function* () {
      return ({ text, version }) =>
        Effect.sleep("2 seconds").pipe(
          Effect.as(Message.CompletedWaitBeforeClearCopy({ text, version })),
        );
    },
  },
);

export const EffectsLayer = Layer.mergeAll(
  WaitForReply.layer,
  FollowChat.layer,
  CopyCommand.layer,
  WaitBeforeClearCopy.layer,
);
