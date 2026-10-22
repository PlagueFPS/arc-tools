import * as stylex from "@stylexjs/stylex";
import type { StaticStyles } from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message";
import { elementClass, styles as sharedStyles } from "../styles";
import { breakpoints, colors } from "../theme.stylex";

const styles = stylex.create({
  liveDot: {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: "#e7ce9c",
  },
  chatPreview: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#49414f",
    borderRadius: 9,
    backgroundColor: "#1e1c23",
    boxShadow: "0 28px 90px #0005",
    transform: { default: "rotate(1.5deg)", [breakpoints.mobile]: "none" },
    maxWidth: { default: null, [breakpoints.mobile]: 500 },
  },
  chatHeader: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: 20,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.5,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  chatExample: {
    marginLeft: "auto",
    color: "#8c8599",
    fontSize: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#41394c",
    borderRadius: 3,
    paddingTop: 3,
    paddingRight: 5,
    paddingBottom: 3,
    paddingLeft: 5,
  },
  chatBody: {
    paddingTop: { default: 32, [breakpoints.mobile]: 25 },
    paddingRight: 22,
    paddingBottom: { default: 25, [breakpoints.mobile]: 21 },
    paddingLeft: 22,
  },
  chatLine: {
    display: "flex",
    gap: 12,
    marginBottom: 25,
    fontSize: 12,
    lineHeight: 1.8,
    color: "#d2cdd8",
  },
  chatName: {
    fontWeight: 700,
    color: "#cfb4a5",
    fontSize: 11,
    marginBottom: 3,
  },
  chatAvatar: {
    width: 28,
    height: 28,
    flexShrink: 0,
    borderRadius: 6,
    backgroundColor: "#423532",
    textAlign: "center",
    lineHeight: "28px",
    color: "#dbbfae",
    fontSize: 12,
  },
  viewerName: {
    color: "#b3cdb8",
  },
  viewerAvatar: {
    backgroundColor: "#2c3935",
    color: "#b3cdb8",
  },
  botMessage: {
    backgroundColor: "#30283d",
    borderLeftWidth: 2,
    borderLeftStyle: "solid",
    borderLeftColor: colors.violet,
    paddingTop: 16,
    paddingRight: 13,
    paddingBottom: 16,
    paddingLeft: 13,
    marginLeft: -6,
    marginRight: -6,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 5,
    borderBottomRightRadius: 5,
    borderBottomLeftRadius: 2,
  },
  botName: {
    color: "#cdb4ff",
  },
  botAvatar: {
    backgroundColor: colors.violet,
    color: "#20182f",
    fontWeight: 700,
  },
  chatNote: {
    fontSize: 10,
    color: "#97909f",
    paddingTop: 6,
    textAlign: "center",
  },
  chatInput: {
    marginTop: 0,
    marginRight: 17,
    marginBottom: 18,
    marginLeft: 17,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#3a3541",
    color: "#8d8698",
    borderRadius: 4,
    paddingTop: 14,
    paddingRight: 12,
    paddingBottom: 14,
    paddingLeft: 12,
    fontSize: 11,
    display: "flex",
    justifyContent: "space-between",
  },
});

const chatLine = (
  name: string,
  content: string,
  appearance: Readonly<{
    message?: StaticStyles;
    name?: StaticStyles;
    avatar?: StaticStyles;
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(elementClass(styles.chatLine, appearance.message))],
    [
      h.span(
        [
          h.Class(elementClass(styles.chatAvatar, appearance.avatar)),
          h.AriaHidden(true),
        ],
        [name.slice(0, 1).toUpperCase()],
      ),
      h.div(
        [h.Class(elementClass())],
        [
          h.p(
            [
              h.Class(
                elementClass(
                  sharedStyles.paragraph,
                  styles.chatName,
                  appearance.name,
                ),
              ),
            ],
            [name],
          ),
          h.p([h.Class(elementClass(sharedStyles.paragraph))], [content]),
        ],
      ),
    ],
  );

export const chatPreview = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class(elementClass(styles.chatPreview)),
      h.AriaLabel("Example Twitch chat"),
    ],
    [
      h.div(
        [h.Class(elementClass(styles.chatHeader))],
        [
          h.span([h.Class(elementClass(styles.liveDot)), h.AriaHidden(true)]),
          "STREAM CHAT",
          h.span([h.Class(elementClass(styles.chatExample))], ["EXAMPLE"]),
        ],
      ),
      h.div(
        [h.Class(elementClass(styles.chatBody))],
        [
          chatLine("raider_01", "anyone know where to find sensors?", {}, h),
          chatLine(
            "luna",
            "!find sensors",
            { name: styles.viewerName, avatar: styles.viewerAvatar },
            h,
          ),
          chatLine(
            "ARC Tools",
            "Item locations, crafting info, sell values. One command away.",
            {
              message: styles.botMessage,
              name: styles.botName,
              avatar: styles.botAvatar,
            },
            h,
          ),
          h.div(
            [h.Class(elementClass(styles.chatNote))],
            ["Ask in chat. Keep your eyes on the raid."],
          ),
        ],
      ),
      h.div(
        [h.Class(elementClass(styles.chatInput)), h.AriaHidden(true)],
        ["Send a message", h.span([h.Class(elementClass())], ["↵"])],
      ),
    ],
  );
