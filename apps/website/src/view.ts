import * as stylex from "@stylexjs/stylex";
import type { Document, HtmlBuilder } from "foldkit/html";

import type { Message } from "./message";
import type { Model } from "./model";
import { AppRoute } from "./route";
import { elementClass, styles as sharedStyles } from "./styles";
import { breakpoints, colors, fonts } from "./theme.stylex";
import { connectView } from "./view/connection";
import { headerView } from "./view/header";
import { landingView } from "./view/landing";
import { notFoundView } from "./view/notFound";

const styles = stylex.create({
  siteShell: {
    minHeight: "100vh",
    backgroundImage:
      "radial-gradient(ellipse at 83% 19%, #26212e66, transparent 43%)",
  },
  siteFooter: {
    display: "flex",
    justifyContent: {
      default: "space-between",
      [breakpoints.tablet]: "flex-start",
    },
    alignItems: "center",
    gap: { default: 25, [breakpoints.mobile]: 14 },
    flexWrap: "wrap",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    paddingTop: 25,
    paddingBottom: 25,
    color: "#8e8996",
    fontSize: 11,
  },
  footerBrand: {
    fontFamily: fonts.heading,
    color: "#c5bfce",
    fontWeight: 600,
    letterSpacing: 1,
    fontSize: 12,
  },
  footerNote: {
    fontSize: 9,
    width: { default: null, [breakpoints.mobile]: "100%" },
  },
  skipLink: {
    position: "absolute",
    top: { default: -100, ":focus": 15 },
    left: 20,
    zIndex: 10,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    backgroundColor: colors.violet,
    color: "#151517",
  },
});

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: AppRoute.match(model.route, {
    Home: () => "ARC Tools · Your chat, raid ready.",
    Connect: () => "Connection status · ARC Tools",
    NotFound: () => "Page not found · ARC Tools",
  }),
  body: h.div(
    [h.Class(elementClass(styles.siteShell))],
    [
      h.a(
        [
          h.Href("#main"),
          h.Class(
            elementClass(
              sharedStyles.link,
              sharedStyles.interactive,
              styles.skipLink,
            ),
          ),
        ],
        ["Skip to content"],
      ),
      headerView(model.route, h),
      h.main(
        [h.Id("main"), h.Tabindex(-1), h.Class(elementClass())],
        [
          AppRoute.match(model.route, {
            Home: () => landingView(model, h),
            Connect: () => connectView(model, h),
            NotFound: () => notFoundView(h),
          }),
        ],
      ),
      h.footer(
        [h.Class(elementClass(styles.siteFooter, sharedStyles.wrap))],
        [
          h.span([h.Class(elementClass(styles.footerBrand))], ["ARC TOOLS"]),
          h.p(
            [h.Class(elementClass(sharedStyles.paragraph))],
            ["Made for the raid. Built for your community."],
          ),
          h.p(
            [
              h.Class(
                elementClass(
                  sharedStyles.paragraph,
                  sharedStyles.small,
                  styles.footerNote,
                ),
              ),
            ],
            [
              "An independent community tool. Not affiliated with Embark Studios or Twitch.",
            ],
          ),
        ],
      ),
    ],
  ),
});
