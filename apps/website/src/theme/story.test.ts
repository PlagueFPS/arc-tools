import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { expect, test } from "vitest";

import { ApplyTheme, ToggleTheme } from "../command";
import { init, update } from "../main";
import { Message } from "../message";
import { effectiveTheme } from "../theme";

const initial = () =>
  init(Option.getOrThrow(fromString("https://bot.invalid/"))).model;

test("system preference changes apply until a user chooses an override", () => {
  story(
    update,
    given(initial()),
    message(Message.ChangedSystemTheme({ theme: "dark" })),
    Command.expectExact(ApplyTheme({ theme: "dark" })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    model((current) =>
      expect(effectiveTheme(current.theme)).toEqual(Option.some("dark")),
    ),
    message(Message.ChangedSystemTheme({ theme: "light" })),
    Command.expectExact(ApplyTheme({ theme: "light" })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    message(Message.ClickedToggleTheme()),
    Command.expectExact(ToggleTheme({ theme: "dark" })),
    Command.resolve(ToggleTheme, Message.CompletedToggleTheme()),
    message(Message.ChangedSystemTheme({ theme: "dark" })),
    Command.expectExact(),
    message(Message.ChangedSystemTheme({ theme: "light" })),
    Command.expectExact(),
    model((current) => {
      expect(current.theme.system).toEqual(Option.some("light"));
      expect(effectiveTheme(current.theme)).toEqual(Option.some("dark"));
    }),
  );
});

test.each([true, false])(
  "a restored override wins regardless of startup order: system first=%s",
  (systemFirst) => {
    const system = Message.ChangedSystemTheme({ theme: "dark" });
    const restored = Message.RestoredTheme({ theme: Option.some("light") });
    let current = initial();

    for (const event of systemFirst ? [system, restored] : [restored, system]) {
      current = update(current, event).model;
    }

    expect(effectiveTheme(current.theme)).toEqual(Option.some("light"));
    expect(
      update(current, Message.ChangedSystemTheme({ theme: "light" })).commands,
    ).toEqual([]);
  },
);

test("late storage restoration cannot replace a user choice", () => {
  const system = update(
    initial(),
    Message.ChangedSystemTheme({ theme: "light" }),
  ).model;

  const chosen = update(system, Message.ClickedToggleTheme()).model;

  const restored = update(
    chosen,
    Message.RestoredTheme({ theme: Option.some("light") }),
  );

  expect(restored.model).toEqual(chosen);
  expect(restored.commands).toBeUndefined();
});
