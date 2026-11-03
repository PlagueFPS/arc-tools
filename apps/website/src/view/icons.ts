import { Array as Arr } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

const paths = {
  twitch:
    "M4 2h18v13l-5 5h-5l-3 3v-3H3V6zm2 2v13h5v3l3-3h4l2-2V4zm5 3h2v6h-2zm5 0h2v6h-2z",
  discord:
    "M19.7 5.3a18 18 0 0 0-4.4-1.4l-.5 1a16 16 0 0 0-5.6 0l-.5-1a18 18 0 0 0-4.4 1.4C1.5 9.5.7 13.6 1.1 17.7a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.8.4-.3a14 14 0 0 0 11.2 0l.4.3-1.7.8 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.8-.8-8.9-3.2-12.4zM8 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z",
};

export const platformIcon = <M>(
  platform: keyof typeof paths,
  h: HtmlBuilder<M>,
): Html =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Class("size-5 shrink-0 fill-current"),
      h.AriaHidden(true),
    ],
    [h.path([h.D(paths[platform])])],
  );

export const brandMark = <M>(
  h: HtmlBuilder<M>,
  className = "size-[31px]",
): Html =>
  h.svg(
    [
      h.ViewBox("0 0 32 32"),
      h.Class(`${className} shrink-0 fill-current`),
      h.AriaHidden(true),
    ],
    [h.path([h.D("M0 29 11 3h7L7 29zm13 0 7-17 12 17h-8l-3-5-2 5z")])],
  );

const themeIconPaths = {
  light: [
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m6.34 17.66-1.41 1.41",
    "m19.07 4.93-1.41 1.41",
  ],
  dark: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
};

export const themeIcon = <M>(
  theme: keyof typeof themeIconPaths,
  h: HtmlBuilder<M>,
): Html =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Class(
        "size-[18px] shrink-0 fill-none stroke-current stroke-[1.75] [stroke-linecap:round] [stroke-linejoin:round]",
      ),
      h.AriaHidden(true),
    ],
    [
      ...(theme === "light"
        ? [h.circle([h.Cx("12"), h.Cy("12"), h.R("4")])]
        : []),
      ...Arr.map(themeIconPaths[theme], (d) => h.path([h.D(d)])),
    ],
  );
