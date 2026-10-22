import { Button } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Match } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  CheckError,
  type EnrollmentStatus,
  canReconnect,
  guidance,
} from "../domain/enrollment";
import { Message } from "../message";
import type { Model } from "../model";
import { homeHref } from "../route";
import { elementClass, styles as sharedStyles } from "../styles";
import { breakpoints, colors } from "../theme.stylex";
import { connectLink } from "./shared";

const styles = stylex.create({
  control: {
    font: "inherit",
    cursor: { default: null, ":disabled": "wait" },
    opacity: { default: null, ":disabled": 0.6 },
  },
  backLink: {
    color: { default: "#bbb3c7", ":hover": colors.violet },
    fontSize: 12,
  },
  secondary: {
    borderColor: "#56505e",
    color: "#f2efe6",
    backgroundColor: { default: "#302c37", ":hover": "#40364d" },
  },
  connectionIntro: {
    fontSize: 14,
    lineHeight: 1.8,
  },
  connectionCard: {
    marginTop: 35,
    paddingTop: { default: 34, [breakpoints.mobile]: 25 },
    paddingRight: { default: 34, [breakpoints.mobile]: 25 },
    paddingBottom: { default: 34, [breakpoints.mobile]: 25 },
    paddingLeft: { default: 34, [breakpoints.mobile]: 25 },
    backgroundColor: "#211e27",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#49414f",
    borderRadius: 8,
  },
  statusTitle: {
    fontSize: 28,
    letterSpacing: -1,
    marginTop: 14,
    marginBottom: 14,
  },
  statusDescription: {
    fontSize: 14,
    lineHeight: 1.9,
    maxWidth: 550,
  },
  cardButton: {
    marginTop: 26,
  },
  statusConnectButton: {
    marginRight: 14,
  },
  connectionFootnote: {
    marginTop: 18,
  },
  readyCommand: {
    display: "flex",
    flexWrap: "wrap",
    gap: 15,
    marginTop: 25,
    paddingTop: 18,
    paddingRight: 18,
    paddingBottom: 18,
    paddingLeft: 18,
    backgroundColor: "#2e263b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#514262",
    borderRadius: 4,
  },
  readyLabel: {
    fontSize: 9,
    letterSpacing: 1.2,
    alignSelf: "center",
  },
  readyCode: {
    fontSize: 14,
  },
  statusWarning: {
    color: "#e2ca9b",
    fontSize: 13,
    lineHeight: 1.8,
    marginTop: 20,
  },
});

const statusHeading = (
  label: string,
  title: string,
  copy: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(elementClass())],
    [
      h.p(
        [h.Class(elementClass(sharedStyles.paragraph, sharedStyles.eyebrow))],
        [label],
      ),
      h.h2(
        [h.Class(elementClass(sharedStyles.heading, styles.statusTitle))],
        [title],
      ),
      h.p(
        [
          h.Class(
            elementClass(
              sharedStyles.paragraph,
              sharedStyles.muted,
              styles.statusDescription,
            ),
          ),
        ],
        [copy],
      ),
    ],
  );

const enrollmentView = (
  status: EnrollmentStatus,
  h: HtmlBuilder<Message>,
): Html =>
  Match.value(status).pipe(
    Match.discriminatorsExhaustive("kind")({
      pending: () =>
        statusHeading(
          "CONNECTION IN PROGRESS",
          "Almost ready.",
          "Your connection is still being verified. If Twitch authorization is open in another tab, finish there first. Then check your status again.",
          h,
        ),
      ready: ({ login }) =>
        h.div(
          [h.Class(elementClass())],
          [
            statusHeading(
              "CHANNEL CONNECTED",
              "You're raid ready.",
              `ARC Tools is ready in ${login}'s Twitch chat.`,
              h,
            ),
            h.div(
              [h.Class(elementClass(styles.readyCommand))],
              [
                h.span(
                  [h.Class(elementClass(styles.readyLabel))],
                  ["TRY IT IN YOUR CHAT"],
                ),
                h.code(
                  [h.Class(elementClass(sharedStyles.code, styles.readyCode))],
                  ["!find sensors"],
                ),
              ],
            ),
          ],
        ),
      failed: ({ reason }) =>
        h.div(
          [h.Class(elementClass())],
          [
            statusHeading(
              "CONNECTION NEEDS ATTENTION",
              "Let's get you connected.",
              guidance(reason),
              h,
            ),
            canReconnect(reason)
              ? connectLink([styles.cardButton, styles.statusConnectButton], h)
              : h.empty,
          ],
        ),
    }),
  );

const errorView = (error: CheckError, h: HtmlBuilder<Message>): Html =>
  CheckError.match(error, {
    Absent: () =>
      h.div(
        [h.Class(elementClass())],
        [
          statusHeading(
            "NO CONNECTION SESSION",
            "Start with Twitch.",
            "There is no connection session in this browser. Connect your channel, or return using the browser where you started.",
            h,
          ),
          connectLink([styles.cardButton, styles.statusConnectButton], h),
        ],
      ),
    Unavailable: () =>
      statusHeading(
        "STATUS UNAVAILABLE",
        "We couldn't check just now.",
        "Your connection status could not be loaded. Check again in a moment. This does not mean your channel has disconnected.",
        h,
      ),
  });

const statusView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.enrollment, {
    onIdle: () =>
      statusHeading(
        "CONNECTION STATUS",
        "Check your connection.",
        "Check the connection session in this browser.",
        h,
      ),
    onLoading: () =>
      statusHeading(
        "CHECKING CONNECTION",
        "Getting your status…",
        "Checking the connection session in this browser.",
        h,
      ),
    onRefreshing: (status) => enrollmentView(status, h),
    onFailure: (error) => errorView(error, h),
    onStale: ({ data }) =>
      h.div(
        [h.Class(elementClass())],
        [
          enrollmentView(data, h),
          h.p(
            [
              h.Class(
                elementClass(sharedStyles.paragraph, styles.statusWarning),
              ),
            ],
            [
              "Status could not be refreshed. The last known status is shown. Check again in a moment.",
            ],
          ),
        ],
      ),
    onSuccess: (status) => enrollmentView(status, h),
  });

export const connectView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isPending = AsyncData.isPending(model.enrollment);

  return h.section(
    [h.Class(elementClass(sharedStyles.contentPage, sharedStyles.wrap))],
    [
      h.a(
        [
          h.Href(homeHref()),
          h.Class(
            elementClass(
              sharedStyles.link,
              sharedStyles.interactive,
              styles.backLink,
            ),
          ),
        ],
        ["← Back to ARC Tools"],
      ),
      h.h1(
        [h.Class(elementClass(sharedStyles.title, sharedStyles.pageTitle))],
        ["Your channel connection."],
      ),
      h.p(
        [
          h.Class(
            elementClass(
              sharedStyles.paragraph,
              styles.connectionIntro,
              sharedStyles.muted,
            ),
          ),
        ],
        ["One place to see if your chat is ready for the next raid."],
      ),
      h.div(
        [h.Class(elementClass(styles.connectionCard))],
        [
          h.div(
            [
              h.Role("status"),
              h.AriaLive("polite"),
              h.AriaAtomic(true),
              h.Class(elementClass()),
            ],
            [statusView(model, h)],
          ),
          Button.view(
            {
              onClick: Message.ClickedCheckStatus(),
              isDisabled: isPending,
              toView: (attributes) =>
                h.button(
                  [
                    ...attributes.button,
                    h.Class(
                      elementClass(
                        styles.control,
                        sharedStyles.interactive,
                        sharedStyles.button,
                        styles.secondary,
                        styles.cardButton,
                      ),
                    ),
                  ],
                  [isPending ? "Checking…" : "Check status"],
                ),
            },
            h,
          ),
          h.p(
            [
              h.Class(
                elementClass(
                  sharedStyles.paragraph,
                  sharedStyles.small,
                  sharedStyles.muted,
                  styles.connectionFootnote,
                ),
              ),
            ],
            [
              "Status belongs to this browser session. Check again after completing Twitch authorization.",
            ],
          ),
        ],
      ),
    ],
  );
};
