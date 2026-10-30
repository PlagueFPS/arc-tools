/* oxlint-disable require-yield -- Foldkit handler recipes require generator constructors even when they capture no Services. */
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { Dom } from "foldkit";

import { LandingDefinition } from "./definition";
import { Message } from "./message";

export const subscriptions = LandingDefinition.makeSubscriptions((entry) => ({
  motion: entry("ObserveChatMotion", {
    messages: [Message.UpdatedReducedMotion],
    handler: function* () {
      return () =>
        Dom.streamFromMediaQuery({
          query: "(prefers-reduced-motion: reduce)",
          mapMatches: (reduced) => Message.UpdatedReducedMotion({ reduced }),
        });
    },
  }),
  rotation: entry(
    "RotateChat",
    { running: Schema.Boolean },
    {
      messages: [Message.TickedChat],
      modelToDependencies: (model) => ({
        running: !model.typing && Option.contains(model.reducedMotion, false),
      }),
      handler: function* () {
        return ({ running }: { readonly running: boolean }) =>
          Stream.when(
            Stream.tick(Duration.millis(2400)).pipe(
              Stream.drop(1),
              Stream.filter(() => {
                const chat = document.getElementById("chat-preview");
                const feed = document.getElementById("chat-feed");

                if (document.hidden || !chat || !feed) return false;
                const bounds = chat.getBoundingClientRect();

                return (
                  bounds.bottom > 0 &&
                  bounds.top < innerHeight &&
                  feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32
                );
              }),
              Stream.map(Message.TickedChat),
            ),
            Effect.succeed(running),
          );
      },
    },
  ),
}));
