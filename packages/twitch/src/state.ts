import { Context, Effect, Schema } from "effect";

import type { AccountIdentity } from "./account.js";
import {
  bounded,
  DispatchOutcome,
  EnrollmentFailure,
  enrollmentTiming,
  EnrollmentSession,
} from "./contracts.js";
import { BroadcasterId } from "./schemas.js";

const maxChannels = 32;

const maxEnrollmentIntents = 8;

const Identity = Schema.Struct({ login: bounded(25), id: bounded(64) });

const Session = Schema.Struct({
  token: bounded(4096),
  expiresAt: Schema.Number,
  validatedAt: Schema.Number,
  generation: Schema.String,
});

const Lease = Schema.Struct({ owner: Schema.String, until: Schema.Number });

const OAuthState = Schema.Struct({
  digest: Schema.String,
  operator: Schema.String,
  revision: Schema.String,
  generation: Schema.Int,
  userId: Schema.String,
  login: Schema.String,
  roles: Schema.Array(Schema.Literals(["sender", "broadcaster"])),
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.Number,
});

const Attempt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    fingerprint: Schema.String,
    deadline: Schema.Number,
    retainUntil: Schema.Number,
    retryAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("sending"),
    fingerprint: Schema.String,
    deadline: Schema.Number,
    retainUntil: Schema.Number,
    owner: Schema.String,
    instance: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    fingerprint: Schema.String,
    deadline: Schema.Number,
    retainUntil: Schema.Number,
    outcome: DispatchOutcome,
    privateCode: Schema.NullOr(bounded(128)),
  }),
]);

const Enrollment = Schema.Struct({
  session: EnrollmentSession,
  nonce: Schema.String,
  revision: Schema.String,
  generation: Schema.Int,
  publicRevocationGeneration: Schema.Int.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  expiresAt: Schema.Number,
  phase: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("pending") }),
    Schema.Struct({ kind: Schema.Literal("exchanging"), lease: Lease }),
    Schema.Struct({
      kind: Schema.Literal("member"),
      broadcasterId: BroadcasterId,
    }),
    Schema.Struct({
      kind: Schema.Literal("failed"),
      reason: EnrollmentFailure,
    }),
  ]),
});

const Repair = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({
    kind: Schema.Literal("scheduled"),
    id: Schema.String,
    due: Schema.Number,
    attempts: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("required") }),
]);

export const AccountState = Schema.Struct({
  revision: Schema.String,
  authGeneration: Schema.Int,
  publicRevocationGeneration: Schema.Int.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  sender: Schema.NullOr(Identity),
  channels: Schema.Array(
    Schema.Struct({ login: bounded(25), id: BroadcasterId }),
  ),
  publicMembers: Schema.Array(
    Schema.Struct({
      login: bounded(25),
      id: BroadcasterId,
      revocationGeneration: Schema.Int.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(0)),
      ),
    }),
  )
    .check(Schema.isMaxLength(maxChannels))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  enrollments: Schema.Array(Enrollment)
    .check(Schema.isMaxLength(maxChannels + maxEnrollmentIntents))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  repair: Repair.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ kind: "idle" })),
  ),
  grants: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  oauth: Schema.Array(OAuthState),
  session: Schema.NullOr(Session),
  tokenLease: Schema.NullOr(Lease),
  tokenRetryAt: Schema.Number,
  nextCredentialCheck: Schema.NullOr(Schema.Number),
  setupLease: Schema.NullOr(
    Schema.Struct({
      owner: Schema.String,
      until: Schema.Number,
      revision: Schema.String,
      generation: Schema.Int,
    }),
  ),
  subscriptions: Schema.Record(
    Schema.String,
    Schema.Struct({
      id: bounded(128),
      broadcasterId: bounded(64),
      senderId: bounded(64),
      callback: Schema.String,
      binding: Schema.String,
      status: bounded(128),
    }),
  ),
  revoked: Schema.Record(
    Schema.String,
    Schema.Struct({
      until: Schema.Number,
      reason: Schema.Literals(["retired", "revoked", "authorization-revoked"]),
    }),
  ),
  attempts: Schema.Record(Schema.String, Attempt),
  reservations: Schema.Array(
    Schema.Struct({ channel: Schema.String, at: Schema.Number }),
  ),
  apiBlockedUntil: Schema.Number,
  credentialFailures: Schema.Int,
});

type Persisted = typeof AccountState.Type;

export type AccountState = {
  -readonly [K in keyof Persisted]: K extends
    | "grants"
    | "subscriptions"
    | "revoked"
    | "attempts"
    ? { -readonly [P in keyof Persisted[K]]: Persisted[K][P] }
    : Persisted[K];
};

export const emptyState = (revision: string): AccountState => ({
  revision,
  authGeneration: 0,
  publicRevocationGeneration: 0,
  sender: null,
  channels: [],
  publicMembers: [],
  enrollments: [],
  repair: { kind: "idle" },
  grants: {},
  oauth: [],
  session: null,
  tokenLease: null,
  tokenRetryAt: 0,
  nextCredentialCheck: null,
  setupLease: null,
  subscriptions: {},
  revoked: {},
  attempts: {},
  reservations: [],
  apiBlockedUntil: 0,
  credentialFailures: 0,
});

export interface Store {
  readonly update: <A>(f: (state: AccountState) => A) => Effect.Effect<A>;
}

export class AccountStore extends Context.Service<AccountStore, Store>()(
  "@arctools/AccountStore",
) {}

export const policy = {
  maxChannels,
  maxOAuth: maxChannels + 1,
  maxEnrollmentIntents,
  enrollmentSessionMs: 86_400_000,
  repairRetryMs: 5_000,
  maxRepairAttempts: 5,
  maxAttempts: 64,
  retentionMs: 600_000,
  oauthMs: 600_000,
  tokenLeaseMs: 10_000,
  enrollmentLeaseMs: enrollmentTiming.exchangeMs,
  setupLeaseMs: 120_000,
  hourlyMs: 3_600_000,
  globalWindowMs: 30_000,
  globalMessages: 20,
  channelMs: 1_000,
};

export function reclaim(state: AccountState, now: number) {
  state.oauth = state.oauth.filter((entry) => entry.expiresAt > now);
  state.reservations = state.reservations.filter(
    (entry) => entry.at + policy.globalWindowMs > now,
  );

  for (const [key, attempt] of Object.entries(state.attempts)) {
    if (attempt.retainUntil <= now) delete state.attempts[key];
  }

  for (const [key, tombstone] of Object.entries(state.revoked)) {
    if (tombstone.until <= now) delete state.revoked[key];
  }
}

export function reserveAt(
  state: AccountState,
  channel: string,
  now: number,
): number {
  const recent = state.reservations.filter(
    (entry) => entry.at + policy.globalWindowMs > now,
  );

  const oldest = recent[recent.length - policy.globalMessages];
  const global = oldest === undefined ? now : oldest.at + policy.globalWindowMs;
  const last = recent.filter((entry) => entry.channel === channel).at(-1);

  return Math.max(
    now,
    global,
    last === undefined ? now : last.at + policy.channelMs,
    state.apiBlockedUntil,
  );
}

export function desiredChannels(
  state: Pick<AccountState, "channels" | "publicMembers">,
  kind: AccountIdentity["kind"],
) {
  const channels = new Map<string, AccountState["channels"][number]>(
    (kind === "production" ? state.publicMembers : []).map((channel) => [
      channel.id,
      channel,
    ]),
  );

  for (const channel of state.channels) channels.set(channel.id, channel);

  return [...channels.values()];
}

export function nextAlarm(state: AccountState): number | null {
  const repair = state.repair.kind === "scheduled" ? state.repair.due : null;

  if (repair === null) return state.nextCredentialCheck;

  return state.nextCredentialCheck === null
    ? repair
    : Math.min(repair, state.nextCredentialCheck);
}
