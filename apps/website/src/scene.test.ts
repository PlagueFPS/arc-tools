import { EnrollmentFailure } from "@arctools/twitch/enrollment";
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
} from "foldkit/scene";
import { test } from "vitest";

import { CheckEnrollment } from "./command";
import {
  CheckError,
  Enrollment,
  RequestId,
  guidance,
} from "./domain/enrollment";
import { update, view } from "./main";
import { Message } from "./message";
import type { Model } from "./model";
import { AppRoute } from "./route";

const connection: Model = {
  route: AppRoute.Connect(),
  enrollment: Enrollment.Idle(),
  requestId: RequestId.make(0),
};

test("landing explains the bot with real chat commands and Twitch navigation", () => {
  scene(
    { update, view },
    given({ ...connection, route: AppRoute.Home() }),
    expect(role("heading", { level: 1 })).toContainText("Raid ready."),
    expect(role("link", { name: /Connect Twitch/ })).toExist(),
    expect(text("!find sensors")).toExist(),
    expect(role("link", { name: "Skip to content" })).toExist(),
    expect(selector("#main")).toHaveAttr("tabIndex", "-1"),
    expect(
      role("link", { name: /Connection status/, current: false }),
    ).toExist(),
  );
});

test("the header marks connection status as the current page", () => {
  scene(
    { update, view },
    given(connection),
    expect(
      role("link", { name: /Connection status/, current: "page" }),
    ).toExist(),
  );
});

test("checking disables refresh, then missing session offers Twitch connection", () => {
  scene(
    { update, view },
    given(connection),
    click(role("button", { name: "Check status" })),
    expect(role("button", { name: "Checking…" })).toBeDisabled(),
    expect(role("link", { name: /Connect Twitch/ })).toBeAbsent(),
    Command.resolve(
      CheckEnrollment,
      Message.FailedCheckEnrollment({
        requestId: RequestId.make(1),
        error: CheckError.Absent(),
      }),
    ),
    expect(text("Start with Twitch.")).toExist(),
    expect(role("link", { name: /Connect Twitch/ })).toExist(),
  );
});

test("pending offers refresh without rotating the active session, then ready names the channel", () => {
  scene(
    { update, view },
    given({
      ...connection,
      enrollment: Enrollment.Success({ data: { kind: "pending" } }),
    }),
    expect(text("Almost ready.")).toExist(),
    expect(role("link", { name: /Connect Twitch/ })).toBeAbsent(),
    click(role("button", { name: "Check status" })),
    expect(text("Almost ready.")).toExist(),
    Command.resolve(
      CheckEnrollment,
      Message.SucceededCheckEnrollment({
        requestId: RequestId.make(1),
        status: { kind: "ready", login: "raider" },
      }),
    ),
    expect(text("ARC Tools is ready in raider's Twitch chat.")).toExist(),
    expect(text("!find sensors")).toExist(),
  );
});

test("request failure is actionable and can be retried", () => {
  scene(
    { update, view },
    given(connection),
    click(role("button", { name: "Check status" })),
    Command.resolve(
      CheckEnrollment,
      Message.FailedCheckEnrollment({
        requestId: RequestId.make(1),
        error: CheckError.Unavailable(),
      }),
    ),
    expect(text("We couldn't check just now.")).toExist(),
    expect(role("button", { name: "Check status" })).not.toBeDisabled(),
    click(role("button", { name: "Check status" })),
    Command.resolve(
      CheckEnrollment,
      Message.SucceededCheckEnrollment({
        requestId: RequestId.make(2),
        status: { kind: "pending" },
      }),
    ),
    expect(text("Almost ready.")).toExist(),
  );
});

test.each(EnrollmentFailure.literals)(
  "enrollment failure %s gives honest guidance",
  (reason) => {
    scene(
      { update, view },
      given({
        ...connection,
        enrollment: Enrollment.Success({ data: { kind: "failed", reason } }),
      }),
      expect(text(guidance(reason))).toExist(),
      expect(role("button", { name: "Check status" })).toExist(),
    );
  },
);

test("failed refresh labels the prior status as last known", () => {
  scene(
    { update, view },
    given({
      ...connection,
      enrollment: Enrollment.Stale({
        data: { kind: "ready", login: "raider" },
        error: CheckError.Unavailable(),
      }),
    }),
    expect(text("ARC Tools is ready in raider's Twitch chat.")).toExist(),
    expect(text(/The last known status is shown/)).toExist(),
  );
});
