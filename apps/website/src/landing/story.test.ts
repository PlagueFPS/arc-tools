import { Array as Arr, Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vitest";

import { FollowChat, WaitForReply } from "./command";
import { Message } from "./message";
import { initialModel } from "./model";
import { update } from "./update";

test("trying a command preserves history and receives a reply addressed to You", () => {
  const initial = initialModel();

  story(
    update,
    given(initial),
    message(Message.ClickedTryCommand({ text: "!find sensors" })),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    model((current) => {
      expect(current.lines.slice(0, 6)).toEqual(initial.lines);
      expect(Arr.last(current.lines).pipe(Option.getOrThrow)).toMatchObject({
        author: "You",
        text: "!find sensors",
      });
    }),
    Command.resolve(
      WaitForReply,
      Message.CompletedWaitForReply({
        text: "Sensors can be found in Security, Technological areas and can be dropped by Snitch, ARC Surveyor.",
      }),
    ),
    Command.resolve(FollowChat, Message.CompletedFollowChat()),
    model((current) =>
      expect(Arr.last(current.lines).pipe(Option.getOrThrow)).toMatchObject({
        author: "ARCToolsBot",
        text: "@You Sensors can be found in Security, Technological areas and can be dropped by Snitch, ARC Surveyor.",
      }),
    ),
  );
});

test("rotation is bounded and typing or reduced motion hold it still", () => {
  let current = { ...initialModel(), reducedMotion: Option.some(false) };

  for (let tick = 0; tick < 100; tick++)
    current = update(current, Message.TickedChat()).model;

  expect(current.lines).toHaveLength(32);
  expect(new Set(Arr.map(current.lines, (line) => line.id)).size).toBe(32);
  expect(Arr.some(current.lines, (line) => line.author === "ARCToolsBot")).toBe(
    true,
  );

  for (const event of [
    Message.FocusedChatInput(),
    Message.UpdatedReducedMotion({ reduced: true }),
  ]) {
    const stopped = update(
      { ...initialModel(), reducedMotion: Option.some(false) },
      event,
    ).model;

    expect(update(stopped, Message.TickedChat()).model.lines).toEqual(
      stopped.lines,
    );
  }
});

test("clearing an older copy indicator preserves a more recent copy", () => {
  const copied = update(
    initialModel(),
    Message.SucceededCopyCommand({ text: "!find sensors" }),
  ).model;

  const newer = update(
    copied,
    Message.SucceededCopyCommand({ text: "!active" }),
  ).model;

  expect(
    update(
      newer,
      Message.CompletedWaitBeforeClearCopy({
        text: "!find sensors",
        version: 1,
      }),
    ).model.copied,
  ).toEqual(Option.some("!active"));
});

test("an older timer cannot clear repeated copies of the same command", () => {
  const first = update(
    initialModel(),
    Message.SucceededCopyCommand({ text: "!active" }),
  ).model;

  const latest = update(
    first,
    Message.SucceededCopyCommand({ text: "!active" }),
  ).model;

  const oldTimer = update(
    latest,
    Message.CompletedWaitBeforeClearCopy({
      text: "!active",
      version: first.copyVersion,
    }),
  ).model;

  expect(oldTimer.copied).toEqual(Option.some("!active"));
  expect(
    update(
      oldTimer,
      Message.CompletedWaitBeforeClearCopy({
        text: "!active",
        version: latest.copyVersion,
      }),
    ).model.copied,
  ).toEqual(Option.none());
});

test("normal motion resumes after the OS reduced-motion setting is turned off", () => {
  const reduced = update(
    initialModel(),
    Message.UpdatedReducedMotion({ reduced: true }),
  ).model;

  const normal = update(
    reduced,
    Message.UpdatedReducedMotion({ reduced: false }),
  ).model;

  expect(update(normal, Message.TickedChat()).model.lines).toHaveLength(
    normal.lines.length + 1,
  );
});
