import type { Effect } from "effect";
import { Context, Schema } from "effect";

import type { EnrollmentStatus } from "./enrollment-contracts.js";
import { AttemptId, BroadcasterId, Deadline } from "./schemas.js";

export { EnrollmentFailure, EnrollmentStatus } from "./enrollment-contracts.js";

export const bounded = (max: number) =>
  Schema.NonEmptyString.check(Schema.isMaxLength(max));

export const ReplyId = bounded(128).pipe(Schema.brand("TwitchReplyId"));

export const Dispatch = Schema.Struct({
  attemptId: AttemptId.check(Schema.isMaxLength(160)),
  broadcasterId: BroadcasterId.check(Schema.isMaxLength(64)),
  replyParentId: ReplyId,
  text: bounded(500),
  deadline: Deadline,
});

export type Dispatch = typeof Dispatch.Type;

export const DispatchOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sent"), messageId: bounded(128) }),
  Schema.Struct({ kind: Schema.Literal("rejected") }),
  Schema.Struct({ kind: Schema.Literal("retryable"), retryAt: Deadline }),
  Schema.Struct({ kind: Schema.Literal("ambiguous") }),
  Schema.Struct({ kind: Schema.Literal("expired") }),
]);

export type DispatchOutcome = typeof DispatchOutcome.Type;

export const enrollmentTiming = {
  exchangeMs: 14_000,
  callbackMs: 16_000,
};

export const eventSubTiming = {
  maxAgeMs: 600_000,
  futureSkewMs: 30_000,
};

export class AccountError extends Schema.TaggedError<AccountError>()(
  "AccountError",
  {
    code: Schema.Literals([
      "configuration",
      "busy",
      "provider",
      "identity",
      "client",
      "scopes",
      "state",
      "capacity",
      "input",
      "stale",
    ]),
  },
) {}

export const OAuthCompletion = Schema.Struct({
  state: bounded(128),
  code: bounded(2048),
  operator: bounded(128),
});

export type OAuthCompletion = typeof OAuthCompletion.Type;

export const SubscriptionObservation = Schema.Struct({
  binding: bounded(128),
  callback: bounded(512),
  id: bounded(128),
  broadcasterId: BroadcasterId,
  senderId: bounded(64),
  status: bounded(128),
});

export type SubscriptionObservation = typeof SubscriptionObservation.Type;

export const AccountStatus = Schema.Struct({
  stage: Schema.String,
  revision: Schema.String,
  setup: Schema.Literals([
    "unresolved",
    "authorization-required",
    "ingress-required",
    "pending",
    "ready",
    "repair-required",
  ]),
  credential: Schema.Literals(["absent", "valid", "validation-required"]),
  sender: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      id: Schema.String,
      authorized: Schema.Boolean,
    }),
  ),
  channels: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      id: BroadcasterId,
      authorized: Schema.Boolean,
      subscription: Schema.String,
    }),
  ),
  attempts: Schema.Int,
  credentialCheckAt: Schema.NullOr(Schema.Number),
});

export type AccountStatus = typeof AccountStatus.Type;

export const SetupResult = Schema.Struct({
  status: AccountStatus,
  authorizations: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      roles: Schema.Array(Schema.Literals(["sender", "broadcaster"])),
      url: Schema.String,
    }),
  ),
});

export type SetupResult = typeof SetupResult.Type;

export interface Account {
  readonly dispatch: (
    input: Dispatch,
  ) => Effect.Effect<DispatchOutcome, AccountError>;
  readonly setup: (
    operator: string,
  ) => Effect.Effect<SetupResult, AccountError>;
  readonly completeOAuth: (
    input: OAuthCompletion,
  ) => Effect.Effect<AccountStatus, AccountError>;
  readonly status: () => Effect.Effect<AccountStatus, AccountError>;
  readonly observeSubscription: (
    input: SubscriptionObservation,
  ) => Effect.Effect<void, AccountError>;
}

export class TwitchAccount extends Context.Service<TwitchAccount, Account>()(
  "@arctools/TwitchAccount",
) {}

export const EnrollmentSession = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("EnrollmentSession"));

export const EnrollmentNonce = Schema.String.check(
  Schema.isPattern(/^enroll\.[a-f0-9]{64}$/),
);

export const EnrollmentBegin = Schema.Struct({
  session: EnrollmentSession,
  previousSession: Schema.NullOr(EnrollmentSession),
  state: EnrollmentNonce,
});

export type EnrollmentBegin = typeof EnrollmentBegin.Type;

export const EnrollmentCompletion = Schema.Struct({
  session: EnrollmentSession,
  state: EnrollmentNonce,
  outcome: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("accepted"), code: bounded(2048) }),
    Schema.Struct({ kind: Schema.Literal("denied") }),
  ]),
});

export type EnrollmentCompletion = typeof EnrollmentCompletion.Type;

export class TwitchEnrollment extends Context.Service<
  TwitchEnrollment,
  {
    readonly begin: (
      input: EnrollmentBegin,
    ) => Effect.Effect<string, AccountError>;
    readonly complete: (
      input: EnrollmentCompletion,
    ) => Effect.Effect<EnrollmentStatus, AccountError>;
    readonly status: (
      session: typeof EnrollmentSession.Type,
    ) => Effect.Effect<EnrollmentStatus, AccountError>;
  }
>()("@arctools/TwitchEnrollment") {}
