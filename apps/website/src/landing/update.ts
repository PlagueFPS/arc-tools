import { Array as Arr, Option, String as Str } from "effect";
import type { Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import {
  CopyCommand,
  FollowChat,
  WaitBeforeClearCopy,
  WaitForReply,
} from "./command";
import { LandingComposition } from "./composition";
import { type ChatLine, chatLoop, replyFor } from "./domain";
import { Message } from "./message";
import { initialModel, type Model } from "./model";

const append = (model: Model, line: Omit<ChatLine, "id">): Model =>
  modifyFields(model, {
    lines: (lines) =>
      Arr.takeRight(Arr.append(lines, { ...line, id: model.nextId }), 32),
    nextId: (id) => id + 1,
  });

type Requirements = Command.HandlerOf<
  | typeof CopyCommand
  | typeof FollowChat
  | typeof WaitBeforeClearCopy
  | typeof WaitForReply
>;

const send = (
  model: Model,
  input: string,
): Update.Return<Model, typeof Message.Type, Requirements> => {
  const text = Str.trim(input);

  if (!Str.isNonEmpty(text)) return { model };

  const answer = Option.match(replyFor(text), {
    onSome: (sample) => sample.answer,
    onNone: () =>
      "Try !find sensors, !recycle sensors or !event harvester in this preview.",
  });

  return {
    model: modifyFields(append(model, { author: "You", text }), {
      input: () => "",
      quietTicks: () => 2,
    }),
    commands: [FollowChat(), WaitForReply({ text: answer })],
  };
};

export const init = LandingComposition.makeInit(() => ({
  model: initialModel(),
}));

export const update = LandingComposition.makeUpdate((model, message) =>
  Message.match(message, {
    SelectedCategory: ({ category, animate }) => ({
      model: modifyFields(model, {
        category: () => category,
        animateCategory: () => animate,
      }),
    }),
    UpdatedChatInput: ({ value }) => ({
      model: modifyFields(model, { input: () => value }),
    }),
    FocusedChatInput: () => ({
      model: modifyFields(model, { typing: () => true }),
    }),
    BlurredChatInput: () => ({
      model: modifyFields(model, { typing: () => false }),
    }),
    UpdatedReducedMotion: ({ reduced }) => ({
      model: modifyFields(model, { reducedMotion: () => Option.some(reduced) }),
    }),
    SubmittedChat: () => send(model, model.input),
    ClickedTryCommand: ({ text }) => send(model, text),
    TickedChat: () => {
      if (!Option.contains(model.reducedMotion, false) || model.typing)
        return { model };

      if (model.quietTicks > 0)
        return {
          model: modifyFields(model, { quietTicks: (ticks) => ticks - 1 }),
        };

      return Option.match(Arr.get(chatLoop, model.nextAmbient), {
        onNone: () => ({ model }),
        onSome: (line) => ({
          model: modifyFields(append(model, line), {
            nextAmbient: (index) => (index + 1) % chatLoop.length,
          }),
          commands: [FollowChat()],
        }),
      });
    },
    CompletedWaitForReply: ({ text }) => ({
      model: modifyFields(
        append(model, { author: "ARCToolsBot", text: "@You " + text }),
        { announcement: () => "ARCToolsBot: " + text },
      ),
      commands: [FollowChat()],
    }),
    CompletedFollowChat: () => ({ model }),
    ClickedCopyCommand: ({ text }) => ({
      model,
      commands: [CopyCommand({ text })],
    }),
    SucceededCopyCommand: ({ text }) => ({
      model: modifyFields(model, {
        copied: () => Option.some(text),
        copyVersion: (version) => version + 1,
        announcement: () => "Command copied to clipboard.",
      }),
      commands: [WaitBeforeClearCopy({ text, version: model.copyVersion + 1 })],
    }),
    FailedCopyCommand: () => ({
      model: modifyFields(model, {
        announcement: () => "Couldn’t access the clipboard. Try copying again.",
      }),
    }),
    CompletedWaitBeforeClearCopy: ({ text, version }) => ({
      model:
        Option.contains(model.copied, text) && version === model.copyVersion
          ? modifyFields(model, { copied: () => Option.none() })
          : model,
    }),
  }),
);
