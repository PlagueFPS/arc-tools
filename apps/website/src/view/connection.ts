import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  CheckError,
  EnrollmentStatus,
  canReconnect,
  guidance,
} from "../domain/enrollment";
import { Message } from "../message";
import type { Model } from "../model";
import { homeRouter } from "../route";
import { connectLink, contentPage, eyebrow, pageTitle } from "./shared";

const heading = (
  label: string,
  title: string,
  copy: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [],
    [
      eyebrow({ children: label }, h),
      h.h2(
        [h.Class("my-[14px] font-heading text-[28px] tracking-[-1px]")],
        [title],
      ),
      h.p(
        [h.Class("max-w-[550px] text-sm leading-[1.9] text-muted-foreground")],
        [copy],
      ),
    ],
  );

const checking = (h: HtmlBuilder<Message>) =>
  heading(
    "CHECKING CONNECTION",
    "Getting your status…",
    "Checking the connection session in this browser.",
    h,
  );

const failure = (error: CheckError, h: HtmlBuilder<Message>) =>
  CheckError.match(error, {
    Absent: () =>
      heading(
        "NO CONNECTION SESSION",
        "Start with Twitch.",
        "There is no connection session in this browser. Connect your channel, or return using the browser where you started.",
        h,
      ),
    Unavailable: () =>
      heading(
        "STATUS UNAVAILABLE",
        "We couldn't check just now.",
        "Your connection status could not be loaded. Check again in a moment. This does not mean your channel has disconnected.",
        h,
      ),
  });

const enrollment = (
  status: typeof EnrollmentStatus.Type,
  h: HtmlBuilder<Message>,
): Html => {
  if (status.kind === "pending")
    return heading(
      "CONNECTION IN PROGRESS",
      "Almost ready.",
      "Your connection is still being verified. If Twitch authorization is open in another tab, finish there first. Then check your status again.",
      h,
    );

  if (status.kind === "failed")
    return heading(
      "CONNECTION NEEDS ATTENTION",
      "Let's get you connected.",
      guidance(status.reason),
      h,
    );

  return h.div(
    [],
    [
      heading(
        "CHANNEL CONNECTED",
        "You're raid ready.",
        `ARC Tools is ready in ${status.login}'s Twitch chat.`,
        h,
      ),
      h.div(
        [
          h.Class(
            "mt-[25px] flex flex-wrap gap-[15px] rounded border border-border bg-muted p-[18px]",
          ),
        ],
        [
          h.span(
            [h.Class("self-center text-[9px] tracking-[1.2px]")],
            ["TRY IT IN YOUR CHAT"],
          ),
          h.code([h.Class("text-sm text-foreground")], ["!find sensors"]),
        ],
      ),
    ],
  );
};

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.match(model.enrollment, {
    onIdle: () => checking(h),
    onLoading: () => checking(h),
    onFailure: (error) => failure(error, h),
    onRefreshing: (status) => enrollment(status, h),
    onSuccess: (status) => enrollment(status, h),
    onStale: ({ data }) =>
      h.div(
        [],
        [
          enrollment(data, h),
          h.p(
            [h.Class("mt-5 text-[13px] leading-[1.8] text-foreground")],
            [
              "Status could not be refreshed. The last known status is shown. Check again in a moment.",
            ],
          ),
        ],
      ),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isPending = AsyncData.isPending(model.enrollment);

  const absent = Option.match(AsyncData.getError(model.enrollment), {
    onNone: () => false,
    onSome: CheckError.guards.Absent,
  });

  const reconnect = Option.match(AsyncData.getData(model.enrollment), {
    onNone: () => false,
    onSome: (status) =>
      !isPending && status.kind === "failed" && canReconnect(status.reason),
  });

  return h.section(
    [h.Class(contentPage)],
    [
      h.a(
        [
          h.Href(homeRouter()),
          h.Class("text-xs text-muted-foreground hover:text-foreground"),
        ],
        ["← Back to ARC Tools"],
      ),
      h.h1([h.Class(pageTitle)], ["Your channel connection."]),
      h.p(
        [h.Class("text-sm leading-[1.8] text-muted-foreground")],
        ["One place to see if your chat is ready for the next raid."],
      ),
      Card(
        {
          className:
            "mt-[35px] gap-0 overflow-visible border border-border p-[25px] ring-0 tablet:p-[34px]",
        },
        [
          h.div(
            [h.Role("status"), h.AriaLive("polite"), h.AriaAtomic(true)],
            [statusView(model, h)],
          ),
          h.div(
            [h.Class("mt-[26px] flex flex-wrap gap-[14px]")],
            [
              absent || reconnect ? connectLink({}, h) : h.empty,
              button(
                {
                  variant: "secondary",
                  size: "lg",
                  type: "button",
                  isDisabled: isPending,
                  onClick: Message.ClickedCheckStatus(),
                },
                isPending ? "Checking…" : "Check status",
                h,
              ),
            ],
          ),
          h.p(
            [
              h.Class(
                "mt-[18px] text-[11px] leading-[1.7] text-muted-foreground",
              ),
            ],
            [
              "Status belongs to this browser session. Check again after completing Twitch authorization.",
            ],
          ),
        ],
        h,
      ),
    ],
  );
};
