import { Schema } from "effect";

export const EnrollmentFailure = Schema.Literals([
  "authorization-required",
  "authorization-failed",
  "denied",
  "expired",
  "capacity",
  "repair-required",
  "unavailable",
]);

export const EnrollmentStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pending") }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    login: Schema.NonEmptyString.check(Schema.isMaxLength(25)),
  }),
  Schema.Struct({
    kind: Schema.Literal("recovering"),
    login: Schema.NonEmptyString.check(Schema.isMaxLength(25)),
  }),
  Schema.Struct({
    kind: Schema.Literal("attention-required"),
    login: Schema.NonEmptyString.check(Schema.isMaxLength(25)),
    reason: Schema.Literals([
      "sender-authorization-required",
      "broadcaster-authorization-required",
      "ingress-required",
      "setup-required",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("left"),
    login: Schema.NonEmptyString.check(Schema.isMaxLength(25)),
  }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: EnrollmentFailure }),
]);

export type EnrollmentStatus = typeof EnrollmentStatus.Type;
