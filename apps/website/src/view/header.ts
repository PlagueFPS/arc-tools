import { Nav } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";
import { AppRoute, connectHref, homeHref } from "../route";
import { elementClass, styles as sharedStyles } from "../styles";
import { breakpoints, colors, fonts } from "../theme.stylex";

const styles = stylex.create({
  siteHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: { default: 32, [breakpoints.mobile]: 22 },
    paddingBottom: { default: 32, [breakpoints.mobile]: 22 },
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  wordmark: {
    display: "flex",
    alignItems: "center",
    gap: { default: 8, [breakpoints.narrow]: 5 },
    fontFamily: fonts.heading,
    fontSize: { default: 21, [breakpoints.mobile]: 17 },
    fontWeight: 700,
    letterSpacing: -0.6,
  },
  wordmarkLight: {
    fontWeight: 400,
    color: "#bdbac5",
  },
  brandMark: {
    display: "grid",
    alignItems: "center",
    justifyItems: "center",
    width: { default: 31, [breakpoints.mobile]: 26 },
    height: { default: 33, [breakpoints.mobile]: 29 },
    marginRight: 5,
    backgroundColor: colors.violet,
    color: "#17131f",
    fontSize: 26,
    transform: "skew(-9deg)",
  },
  navLink: {
    color: { default: "#d2cfd8", ":hover": colors.violet },
    fontSize: { default: 13, [breakpoints.mobile]: 11 },
    display: "flex",
    gap: { default: 21, [breakpoints.mobile]: 8 },
    alignItems: "center",
  },
  currentNavLink: {
    color: colors.violet,
  },
  navArrow: {
    display: { default: null, [breakpoints.narrow]: "none" },
  },
});

const HeaderDestination = Schema.Literals(["Connection status"]);

type HeaderDestination = typeof HeaderDestination.Type;

export const headerView = (route: AppRoute, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class(elementClass(styles.siteHeader, sharedStyles.wrap))],
    [
      h.a(
        [
          h.Href(homeHref()),
          h.Class(
            elementClass(
              sharedStyles.link,
              sharedStyles.interactive,
              styles.wordmark,
            ),
          ),
          h.AriaLabel("ARC Tools home"),
        ],
        [
          h.span(
            [h.Class(elementClass(styles.brandMark)), h.AriaHidden(true)],
            ["A"],
          ),
          "ARC",
          h.span([h.Class(elementClass(styles.wordmarkLight))], ["TOOLS"]),
        ],
      ),
      Nav.view<HeaderDestination>({
        items: HeaderDestination.literals,
        ariaLabel: "Main navigation",
        toHref: () => connectHref(),
        isItemCurrent: () => AppRoute.guards.Connect(route),
        toView: ({ nav, items }) =>
          h.nav(
            [...nav, h.Class(elementClass())],
            items.map((item) =>
              h.a(
                [
                  ...item.link,
                  h.Class(
                    elementClass(
                      sharedStyles.link,
                      sharedStyles.interactive,
                      styles.navLink,
                      AppRoute.guards.Connect(route) && styles.currentNavLink,
                    ),
                  ),
                ],
                [
                  item.value,
                  h.span(
                    [
                      h.AriaHidden(true),
                      h.Class(elementClass(styles.navArrow)),
                    ],
                    ["↗"],
                  ),
                ],
              ),
            ),
          ),
      }),
    ],
  );
