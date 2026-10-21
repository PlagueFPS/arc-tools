import { Schema } from "effect";

const identifier = Schema.NonEmptyString;

export const BroadcasterId = identifier.pipe(Schema.brand("BroadcasterId"));

export const AttemptId = identifier.pipe(Schema.brand("AttemptId"));

export const Deadline = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("Deadline"),
);

export type BroadcasterId = typeof BroadcasterId.Type;

export type AttemptId = typeof AttemptId.Type;

export type Deadline = typeof Deadline.Type;
