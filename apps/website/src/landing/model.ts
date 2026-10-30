import { Array as Arr, Option, Schema } from "effect";

import { Category, ChatLine, chatLoop } from "./domain";

export const Model = Schema.Struct({
  category: Category,
  lines: Schema.Array(ChatLine),
  nextId: Schema.Int,
  nextAmbient: Schema.Int,
  input: Schema.String,
  typing: Schema.Boolean,
  animateCategory: Schema.Boolean,
  reducedMotion: Schema.Option(Schema.Boolean),
  quietTicks: Schema.Int,
  copied: Schema.Option(Schema.String),
  copyVersion: Schema.Int,
  announcement: Schema.String,
});

export type Model = typeof Model.Type;

export const initialModel = (): Model => ({
  category: "All",
  lines: Arr.map(Arr.take(chatLoop, 6), (line, id) => ({ ...line, id })),
  nextId: 6,
  nextAmbient: 6,
  input: "",
  typing: false,
  animateCategory: false,
  reducedMotion: Option.none(),
  quietTicks: 0,
  copied: Option.none(),
  copyVersion: 0,
  announcement: "",
});
