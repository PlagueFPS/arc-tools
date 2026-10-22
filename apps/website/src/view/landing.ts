import * as stylex from "@stylexjs/stylex";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";
import type { Model } from "../model";
import { connectHref } from "../route";
import { elementClass, styles as sharedStyles } from "../styles";
import { breakpoints, colors } from "../theme.stylex";
import { chatPreview } from "./chatPreview";
import { connectLink } from "./shared";

const styles = stylex.create({
  hero: {
    display: "grid",
    gridTemplateColumns: { default: "1.15fr 1fr", [breakpoints.mobile]: "1fr" },
    alignItems: "center",
    gap: { default: 72, [breakpoints.tablet]: 35, [breakpoints.mobile]: 45 },
    paddingTop: {
      default: 98,
      [breakpoints.tablet]: 70,
      [breakpoints.mobile]: 48,
    },
    paddingBottom: {
      default: 88,
      [breakpoints.tablet]: 70,
      [breakpoints.mobile]: 48,
    },
  },
  statusDot: {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: colors.violet,
  },
  accentText: {
    color: colors.violet,
  },
  heroDescription: {
    maxWidth: { default: 430, [breakpoints.mobile]: 480 },
    color: colors.muted,
    lineHeight: 1.8,
    fontSize: 16,
  },
  heroActions: {
    display: "flex",
    alignItems: {
      default: "center",
      [breakpoints.tablet]: "flex-start",
      [breakpoints.mobile]: "center",
      [breakpoints.narrow]: "flex-start",
    },
    gap: { default: 22, [breakpoints.tablet]: 14, [breakpoints.mobile]: 16 },
    marginTop: 33,
    flexDirection: {
      default: null,
      [breakpoints.tablet]: "column",
      [breakpoints.mobile]: "row",
      [breakpoints.narrow]: "column",
    },
  },
  commandStrip: {
    display: "flex",
    alignItems: { default: "center", [breakpoints.tablet]: "flex-start" },
    gap: 13,
    marginTop: 36,
    fontSize: 10,
    color: "#8d8997",
  },
  stripCode: {
    whiteSpace: "nowrap",
  },
  details: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    paddingTop: { default: 44, [breakpoints.mobile]: 35 },
    paddingBottom: 52,
  },
  sectionTitle: {
    fontSize: 29,
    letterSpacing: -1,
    marginTop: 8,
  },
  capabilities: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, 1fr)",
      [breakpoints.mobile]: "1fr",
    },
    gap: { default: 50, [breakpoints.tablet]: 25, [breakpoints.mobile]: 27 },
    marginTop: 35,
  },
  capabilityEyebrow: {
    fontSize: 9,
    color: "#8f869e",
  },
  capabilityTitle: {
    fontSize: 17,
    letterSpacing: -0.4,
    marginTop: { default: 13, [breakpoints.mobile]: 8 },
    marginBottom: { default: 10, [breakpoints.mobile]: 8 },
    fontWeight: 500,
  },
  capabilityCopy: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 1.9,
    maxWidth: { default: 300, [breakpoints.mobile]: "100%" },
  },
  commandList: {
    display: "flex",
    gap: { default: 26, [breakpoints.mobile]: 16 },
    flexWrap: "wrap",
    marginTop: 35,
    alignItems: "center",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    paddingTop: 16,
    paddingRight: 20,
    paddingBottom: 16,
    paddingLeft: 20,
    borderRadius: 5,
  },
  commandListLabel: {
    fontSize: 9,
    color: "#9e97a8",
    letterSpacing: 1.5,
    marginRight: "auto",
    width: { default: null, [breakpoints.mobile]: "100%" },
  },
  heroNote: {
    fontSize: { default: 11, [breakpoints.mobile]: 10 },
  },
});

const capabilityView = (
  number: string,
  title: string,
  copy: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.article(
    [h.Class(elementClass())],
    [
      h.span(
        [h.Class(elementClass(sharedStyles.eyebrow, styles.capabilityEyebrow))],
        [number],
      ),
      h.h3(
        [h.Class(elementClass(sharedStyles.heading, styles.capabilityTitle))],
        [title],
      ),
      h.p(
        [h.Class(elementClass(sharedStyles.paragraph, styles.capabilityCopy))],
        [copy],
      ),
    ],
  );

const heroView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(elementClass(styles.hero, sharedStyles.wrap))],
    [
      h.div(
        [h.Class(elementClass())],
        [
          h.p(
            [
              h.Class(
                elementClass(sharedStyles.paragraph, sharedStyles.eyebrow),
              ),
            ],
            [
              h.span([
                h.Class(elementClass(styles.statusDot)),
                h.AriaHidden(true),
              ]),
              "BUILT FOR ARC RAIDERS · ON TWITCH",
            ],
          ),
          h.h1(
            [h.Class(elementClass(sharedStyles.title))],
            [
              "Your chat.",
              h.br([h.Class(elementClass())]),
              h.span(
                [h.Class(elementClass(styles.accentText))],
                ["Raid ready."],
              ),
            ],
          ),
          h.p(
            [
              h.Class(
                elementClass(sharedStyles.paragraph, styles.heroDescription),
              ),
            ],
            [
              "Less alt-tabbing. More raiding. Give your community item, crafting, and event answers right in Twitch chat.",
            ],
          ),
          h.div(
            [h.Class(elementClass(styles.heroActions))],
            [
              Option.match(AsyncData.getData(model.enrollment), {
                onNone: () => connectLink(undefined, h),
                onSome: () =>
                  h.a(
                    [
                      h.Href(connectHref()),
                      h.Class(
                        elementClass(
                          sharedStyles.link,
                          sharedStyles.interactive,
                          sharedStyles.button,
                          sharedStyles.primary,
                        ),
                      ),
                    ],
                    ["View connection status", "↗"],
                  ),
              }),
              h.p(
                [
                  h.Class(
                    elementClass(
                      sharedStyles.paragraph,
                      sharedStyles.small,
                      sharedStyles.muted,
                      styles.heroNote,
                    ),
                  ),
                ],
                [
                  "Connect your channel through Twitch.",
                  h.br([h.Class(elementClass())]),
                  "No downloads. No chat overlay.",
                ],
              ),
            ],
          ),
          h.div(
            [h.Class(elementClass(styles.commandStrip))],
            [
              h.code(
                [h.Class(elementClass(sharedStyles.code, styles.stripCode))],
                ["!find sensors"],
              ),
              h.span(
                [h.Class(elementClass())],
                ["A little less searching. A lot more playing."],
              ),
            ],
          ),
        ],
      ),
      chatPreview(h),
    ],
  );

const detailsView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class(elementClass(styles.details, sharedStyles.wrap)),
      h.AriaLabel("How ARC Tools works"),
    ],
    [
      h.div(
        [h.Class(elementClass())],
        [
          h.p(
            [
              h.Class(
                elementClass(sharedStyles.paragraph, sharedStyles.eyebrow),
              ),
            ],
            ["YOUR COMMUNITY'S FIELD GUIDE"],
          ),
          h.h2(
            [h.Class(elementClass(sharedStyles.heading, styles.sectionTitle))],
            ["Good intel. Zero detours."],
          ),
        ],
      ),
      h.div(
        [h.Class(elementClass(styles.capabilities))],
        [
          capabilityView(
            "01 / CONNECT",
            "Your channel, connected.",
            "Authorize your broadcaster account with Twitch. We check the channel connection before calling it ready.",
            h,
          ),
          capabilityView(
            "02 / ASK",
            "Let chat do the asking.",
            "Find items, check what to craft, or see what's happening topside. Viewers use simple chat commands.",
            h,
          ),
          capabilityView(
            "03 / RAID",
            "Stay in the moment.",
            "Answers land in chat, where the conversation already is. You keep playing. Everyone keeps up.",
            h,
          ),
        ],
      ),
      h.div(
        [h.Class(elementClass(styles.commandList))],
        [
          h.span(
            [h.Class(elementClass(styles.commandListLabel))],
            ["IN YOUR CHAT"],
          ),
          h.code([h.Class(elementClass(sharedStyles.code))], ["!find sensors"]),
          h.code(
            [h.Class(elementClass(sharedStyles.code))],
            ["!craft sensors"],
          ),
          h.code([h.Class(elementClass(sharedStyles.code))], ["!active"]),
        ],
      ),
    ],
  );

export const landingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class(elementClass())], [heroView(model, h), detailsView(h)]);
