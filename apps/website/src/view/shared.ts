import type { StaticStyles } from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";
import { enrollmentPath } from "../route";
import { elementClass, styles as sharedStyles } from "../styles";

export const connectLink = (
  appearance: StaticStyles,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(enrollmentPath),
      h.Class(
        elementClass(
          sharedStyles.link,
          sharedStyles.interactive,
          sharedStyles.button,
          sharedStyles.primary,
          appearance,
        ),
      ),
    ],
    [
      "Connect Twitch",
      h.span([h.AriaHidden(true), h.Class(elementClass())], ["↗"]),
    ],
  );
