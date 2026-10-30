import type { Html } from "foldkit/html";

import type { ApplicationViewBuilder } from "../composition";
import { homeRouter } from "../route";
import { contentPage, eyebrow, pageTitle, primaryButton } from "./shared";

export const view = (h: ApplicationViewBuilder): Html =>
  h.section(
    [h.Class(contentPage)],
    [
      eyebrow({ children: "404 / OFF THE MAP" }, h),
      h.h1([h.Class(pageTitle)], ["Nothing to loot here."]),
      h.p(
        [h.Class("mb-6 text-muted-foreground")],
        ["This page could not be found."],
      ),
      h.a(
        [h.Href(homeRouter()), h.Class(primaryButton)],
        ["Back to ARCToolsBot"],
      ),
    ],
  );
