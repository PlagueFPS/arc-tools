import {
  Command,
  click,
  expect,
  given,
  label,
  keydown,
  expectHandled,
  role,
  scene,
  selector,
  submit,
  type,
} from "foldkit/scene";
import { test } from "vitest";

import {
  CopyCommand,
  FollowChat,
  WaitBeforeClearCopy,
  WaitForReply,
} from "./command";
import { Message } from "./message";
import { initialModel } from "./model";
import { update } from "./update";
import { view } from "./view";

test("category filters keep both provider examples and omit unrelated commands", () => {
  scene(
    { update, view },
    given(initialModel()),
    expect(role("searchbox")).toBeAbsent(),
    click(role("button", { name: "Events" })),
    expect(role("heading", { name: "find" })).toBeAbsent(),
    expect(
      role("button", { name: "Copy twitch example for active" }),
    ).toExist(),
    expect(
      role("button", { name: "Copy discord example for active" }),
    ).toExist(),
    click(role("button", { name: "All" })),
    expect(role("heading", { name: "find" })).toExist(),
    click(role("button", { name: "Copy discord example for find" })),
    Command.resolve(
      CopyCommand,
      Message.SucceededCopyCommand({ text: "/find item:sensors" }),
    ),
    Command.resolve(
      WaitBeforeClearCopy,
      Message.CompletedWaitBeforeClearCopy({
        text: "/find item:sensors",
        version: 1,
      }),
    ),
    expect(selector('[role="status"][aria-live="polite"]')).toContainText(
      "Command copied to clipboard.",
    ),
  );
});

test("try buttons and the composer append messages as You", () => {
  scene(
    { update, view },
    given(initialModel()),
    click(role("button", { name: "!find sensors" })),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    expect(role("log")).toContainText("You: !find sensors"),
    Command.resolve(
      WaitForReply,
      Message.CompletedWaitForReply({
        text: "Sensors can be found in Security, Technological areas and can be dropped by Snitch, ARC Surveyor.",
      }),
    ),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    expect(role("log")).toContainText(
      "@You Sensors can be found in Security, Technological areas",
    ),
    type(label("Try a chat command"), "!event harvester"),
    submit(selector("form")),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    Command.resolve(
      WaitForReply,
      Message.CompletedWaitForReply({
        text: "Harvester on Blue Gate starts in 18m",
      }),
    ),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    expect(role("log")).toContainText("You: !event harvester"),
    expect(label("Try a chat command")).toHaveValue(""),
    expect(role("button", { name: "Pause live chat preview" })).toBeAbsent(),
  );
});

test("keyboard category selection updates immediately and keeps focus on the picker", () => {
  scene(
    { update, view },
    given(initialModel()),
    keydown(role("button", { name: "All" }), "ArrowRight"),
    expectHandled(),
    expect(role("button", { name: "Items", pressed: true })).toExist(),
    expect(role("heading", { name: "active" })).toBeAbsent(),
    keydown(role("button", { name: "Workshop" }), "Enter"),
    expectHandled(),
    expect(role("button", { name: "Workshop", pressed: true })).toExist(),
  );
});
