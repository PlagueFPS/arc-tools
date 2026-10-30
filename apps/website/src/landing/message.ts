import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Category } from "./domain";

export const Message = defineMessageUnion({
  SelectedCategory: { category: Category, animate: Schema.Boolean },
  UpdatedChatInput: { value: Schema.String },
  FocusedChatInput: {},
  BlurredChatInput: {},
  SubmittedChat: {},
  ClickedTryCommand: { text: Schema.String },
  UpdatedReducedMotion: { reduced: Schema.Boolean },
  TickedChat: {},
  CompletedWaitForReply: { text: Schema.String },
  CompletedFollowChat: {},
  ClickedCopyCommand: { text: Schema.String },
  SucceededCopyCommand: { text: Schema.String },
  FailedCopyCommand: {},
  CompletedWaitBeforeClearCopy: { text: Schema.String, version: Schema.Int },
});
