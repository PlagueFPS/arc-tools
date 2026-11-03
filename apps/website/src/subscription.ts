/* oxlint-disable require-yield -- Foldkit subscription constructors capture no Services here. */
import { Dom } from "foldkit";

import { ApplicationDefinition } from "./definition";
import { Message } from "./message";

export const subscriptions = ApplicationDefinition.makeSubscriptions(
  (entry) => ({
    systemTheme: entry("ObserveSystemTheme", {
      messages: [Message.ChangedSystemTheme],
      handler: function* () {
        return () =>
          Dom.streamFromMediaQuery({
            query: "(prefers-color-scheme: dark)",
            mapMatches: (dark) =>
              Message.ChangedSystemTheme({ theme: dark ? "dark" : "light" }),
          });
      },
    }),
  }),
);
