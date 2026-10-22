import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";
import { homeHref } from "../route";
import { elementClass, styles as sharedStyles } from "../styles";

export const notFoundView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(elementClass(sharedStyles.contentPage, sharedStyles.wrap))],
    [
      h.p(
        [h.Class(elementClass(sharedStyles.paragraph, sharedStyles.eyebrow))],
        ["404 / OFF THE MAP"],
      ),
      h.h1(
        [h.Class(elementClass(sharedStyles.title, sharedStyles.pageTitle))],
        ["Nothing to loot here."],
      ),
      h.p(
        [h.Class(elementClass(sharedStyles.paragraph, sharedStyles.muted))],
        ["This page could not be found."],
      ),
      h.a(
        [
          h.Href(homeHref()),
          h.Class(
            elementClass(
              sharedStyles.link,
              sharedStyles.interactive,
              sharedStyles.button,
              sharedStyles.primary,
            ),
          ),
        ],
        ["Back to ARC Tools"],
      ),
    ],
  );
