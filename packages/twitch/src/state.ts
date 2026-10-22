import { Context, Effect, Schema, Struct } from "effect";

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
  publicRevocationGeneration: Schema.Int,
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

const PublicMember = Schema.Struct({
  login: bounded(25),
  id: BroadcasterId,
  revocationGeneration: Schema.Int,
});

export const AccountState = Schema.Struct({
  revision: Schema.String,
  authGeneration: Schema.Int,
  publicRevocationGeneration: Schema.Int,
  sender: Schema.NullOr(Identity),
  channels: Schema.Array(
    Schema.Struct({ login: bounded(25), id: BroadcasterId }),
  ),
  publicMembers: Schema.Array(PublicMember).check(
    Schema.isMaxLength(maxChannels),
  ),
  enrollments: Schema.Array(Enrollment).check(
    Schema.isMaxLength(maxChannels + maxEnrollmentIntents),
  ),
  repair: Repair,
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

export const SharedAccount = AccountState.mapFields(
  Struct.omit([
    "channels",
    "publicMembers",
    "subscriptions",
    "revoked",
    "oauth",
    "attempts",
    "enrollments",
  ]),
);

export type SharedAccount = Pick<AccountState, keyof typeof SharedAccount.Type>;

export const ChannelRecord = Schema.Struct({
  configured: Schema.Array(
    Schema.Struct({
      position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      member: AccountState.fields.channels.value,
    }),
  ),
  public: Schema.Array(
    Schema.Struct({
      position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      member: PublicMember,
    }),
  ),
  subscription: Schema.NullOr(AccountState.fields.subscriptions.value),
});

export type ChannelRecord = typeof ChannelRecord.Type;

export function splitAccount(state: AccountState) {
  const {
    channels,
    publicMembers,
    subscriptions,
    revoked,
    oauth,
    attempts,
    enrollments,
    ...shared
  } = state;

  const records = new Map<string, ChannelRecord>();

  const entry = (id: string): ChannelRecord =>
    records.get(id) ?? { configured: [], public: [], subscription: null };

  channels.forEach((member, position) => {
    const prior = entry(member.id);
    records.set(member.id, {
      ...prior,
      configured: [...prior.configured, { position, member }],
    });
  });
  publicMembers.forEach((member, position) => {
    const prior = entry(member.id);
    records.set(member.id, {
      ...prior,
      public: [...prior.public, { position, member }],
    });
  });

  for (const [key, subscription] of Object.entries(subscriptions))
    records.set(key, { ...entry(key), subscription });

  return { shared, channels: records, revoked, oauth, attempts, enrollments };
}

export type AccountDirectory = ReturnType<typeof splitAccount>;

export class DirectoryValidationError extends Schema.TaggedError<DirectoryValidationError>()(
  "DirectoryValidationError",
  {
    reason: Schema.Literals(["positions", "key"]),
    message: Schema.String,
  },
) {}

export const joinDirectory = Effect.fnUntraced(function* (
  directory: AccountDirectory,
): Effect.fn.Return<AccountState, DirectoryValidationError> {
  const configured = [...directory.channels.values()]
    .flatMap((record) => record.configured)
    .sort((a, b) => a.position - b.position);

  const members = [...directory.channels.values()]
    .flatMap((record) => record.public)
    .sort((a, b) => a.position - b.position);

  for (const entries of [configured, members])
    if (entries.some((entry, index) => entry.position !== index))
      return yield* new DirectoryValidationError({
        reason: "positions",
        message: "Conflicting channel membership positions",
      });

  for (const [key, record] of directory.channels)
    if (
      [...record.configured, ...record.public].some(
        (entry) => entry.member.id !== key,
      )
    )
      return yield* new DirectoryValidationError({
        reason: "key",
        message: "Conflicting channel membership key",
      });

  return {
    ...directory.shared,
    channels: configured.map((entry) => entry.member),
    publicMembers: members.map((entry) => entry.member),
    subscriptions: Object.fromEntries(
      [...directory.channels].flatMap(([key, record]) =>
        record.subscription === null ? [] : [[key, record.subscription]],
      ),
    ),
    revoked: directory.revoked,
    oauth: directory.oauth,
    attempts: directory.attempts,
    enrollments: directory.enrollments,
  };
});

export type SendAttemptState = SharedAccount & Pick<AccountState, "attempts">;

export type ChannelDispatchState = SendAttemptState &
  Pick<Persisted, "channels" | "publicMembers" | "subscriptions"> &
  Pick<AccountState, "revoked">;

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
  readonly shared: <A>(f: (state: SharedAccount) => A) => Effect.Effect<A>;
  readonly sendAttempt: <A>(
    f: (state: SendAttemptState) => A,
  ) => Effect.Effect<A>;
  readonly channelDispatch: <A>(
    id: BroadcasterId,
    f: (state: ChannelDispatchState) => A,
  ) => Effect.Effect<A>;
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

export function reclaimSend(state: SendAttemptState, now: number) {
  state.reservations = state.reservations.filter(
    (entry) => entry.at + policy.globalWindowMs > now,
  );

  for (const [key, attempt] of Object.entries(state.attempts)) {
    if (attempt.retainUntil <= now) delete state.attempts[key];
  }
}

export function reclaim(state: AccountState, now: number) {
  reclaimSend(state, now);
  state.oauth = state.oauth.filter((entry) => entry.expiresAt > now);

  for (const [key, tombstone] of Object.entries(state.revoked)) {
    if (tombstone.until <= now) delete state.revoked[key];
  }
}

export function reserveAt(
  state: Pick<AccountState, "reservations" | "apiBlockedUntil">,
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

export function nextAlarm(
  state: Pick<AccountState, "repair" | "nextCredentialCheck">,
): number | null {
  const repair = state.repair.kind === "scheduled" ? state.repair.due : null;

  if (repair === null) return state.nextCredentialCheck;

  return state.nextCredentialCheck === null
    ? repair
    : Math.min(repair, state.nextCredentialCheck);
}
