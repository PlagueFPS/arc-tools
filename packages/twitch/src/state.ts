import { Context, Effect, Schema, Struct } from "effect";

import type { AccountIdentity } from "./account.js";
import {
  bounded,
  DispatchOutcome,
  EnrollmentFailure,
  enrollmentTiming,
  eventSubTiming,
  EnrollmentSession,
  InstallationId,
  ChatSource,
  SubscriptionObservation,
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
  removalSequence: Schema.Int.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  userId: Schema.String,
  login: Schema.String,
  roles: Schema.Array(Schema.Literals(["sender", "broadcaster"])),
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.Number,
});

const Attempt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
    fingerprint: Schema.String,
    deadline: Schema.Number,
    retainUntil: Schema.Number,
    retryAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("sending"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
    fingerprint: Schema.String,
    deadline: Schema.Number,
    retainUntil: Schema.Number,
    owner: Schema.String,
    instance: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
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
      kind: Schema.Literal("left"),
      broadcasterId: BroadcasterId,
      login: bounded(25),
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

const legacyCleanupAt = 1;

const PublicMember = Schema.Struct({
  login: bounded(25),
  id: BroadcasterId,
  revocationGeneration: Schema.Int,
  cleanupAfter: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(legacyCleanupAt)),
  ),
});

export const Lifecycle = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("removed"), sequence: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("installed"),
    id: InstallationId,
    sequence: Schema.Int,
    negative: Schema.NullOr(SubscriptionObservation).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
    ),
    version: Schema.Int,
    recovery: Schema.NullOr(
      Schema.Struct({ due: Schema.Number, stage: Schema.Int }),
    ),
    create: Schema.NullOr(
      Schema.Struct({ owner: Schema.String, until: Schema.Number }),
    ),
  }),
]);

export const AccountState = Schema.Struct({
  revision: Schema.String,
  lifecycleVersion: Schema.Int.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  authGeneration: Schema.Int,
  publicRevocationGeneration: Schema.Int,
  sender: Schema.NullOr(Identity),
  channels: Schema.Array(
    Schema.Struct({ login: bounded(25), id: BroadcasterId }),
  ),
  publicMembers: Schema.Array(PublicMember).check(
    Schema.isMaxLength(maxChannels),
  ),
  enrollments: Schema.Array(Enrollment),
  repair: Repair,
  lifecycle: Schema.Record(Schema.String, Lifecycle).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  sweepLease: Schema.NullOr(Lease).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  sweepAt: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  nextRecoveryAt: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  grants: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  oauth: Schema.Array(OAuthState),
  session: Schema.NullOr(Session),
  tokenLease: Schema.NullOr(Lease),
  tokenRetryAt: Schema.Number,
  nextCredentialCheck: Schema.NullOr(Schema.Number),
  nextCleanupAt: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(legacyCleanupAt)),
  ),
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
      deleteVersion: Schema.optional(Schema.Int),
      deleteClaim: Schema.optional(Schema.NullOr(bounded(128))),
      deleteDue: Schema.NullOr(Schema.Number).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(null)),
      ),
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
    | "lifecycle"
    | "grants"
    | "subscriptions"
    | "revoked"
    | "attempts"
    ? { -readonly [P in keyof Persisted[K]]: Persisted[K][P] }
    : Persisted[K];
};

export const SharedAccount = AccountState.mapFields(
  Struct.omit([
    "lifecycle",
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
  lifecycle: Schema.NullOr(Lifecycle).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
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
    lifecycle,
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
    records.get(id) ?? {
      configured: [],
      public: [],
      subscription: null,
      lifecycle: null,
    };

  for (const [id, value] of Object.entries(lifecycle))
    records.set(id, { ...entry(id), lifecycle: value });

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
    lifecycle: Object.fromEntries(
      [...directory.channels].flatMap(([id, record]) =>
        record.lifecycle === null ? [] : [[id, record.lifecycle]],
      ),
    ),
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
  Pick<
    Persisted,
    "channels" | "publicMembers" | "subscriptions" | "lifecycle"
  > &
  Pick<AccountState, "revoked">;

export const emptyState = (revision: string): AccountState => ({
  revision,
  lifecycleVersion: 0,
  authGeneration: 0,
  publicRevocationGeneration: 0,
  sender: null,
  channels: [],
  publicMembers: [],
  enrollments: [],
  repair: { kind: "idle" },
  lifecycle: {},
  sweepAt: null,
  sweepLease: null,
  nextRecoveryAt: null,
  grants: {},
  oauth: [],
  session: null,
  tokenLease: null,
  tokenRetryAt: 0,
  nextCredentialCheck: null,
  nextCleanupAt: null,
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
  recoveryMs: [60_000, 300_000, 900_000],
  sweepMs: 900_000,
  maxAttempts: 64,
  retentionMs: 600_000,
  revocationMs: eventSubTiming.maxAgeMs + eventSubTiming.futureSkewMs + 1,
  oauthMs: 600_000,
  tokenLeaseMs: 10_000,
  enrollmentLeaseMs: enrollmentTiming.exchangeMs,
  setupLeaseMs: 120_000,
  hourlyMs: 3_600_000,
  globalWindowMs: 30_000,
  globalMessages: 20,
  channelMs: 1_000,
};

export const isAuthorizationLoss = (status: string) =>
  status === "authorization_revoked" || status === "user_removed";

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
  state.enrollments = state.enrollments.filter(
    (entry) => entry.expiresAt > now,
  );

  for (const [key, tombstone] of Object.entries(state.revoked)) {
    if (tombstone.until <= now && tombstone.deleteDue === null)
      delete state.revoked[key];
  }

  state.publicMembers = state.publicMembers.flatMap((member) => {
    if (member.cleanupAfter === legacyCleanupAt) {
      const record = state.subscriptions[member.id];

      const cleanupAfter =
        record &&
        isAuthorizationLoss(record.status) &&
        !state.grants[member.id]?.includes("channel:bot") &&
        state.sender?.id !== member.id &&
        !state.channels.some((channel) => channel.id === member.id)
          ? now + Math.max(policy.oauthMs, policy.retentionMs)
          : null;

      if (cleanupAfter !== null)
        state.enrollments = state.enrollments.map((entry) =>
          entry.phase.kind === "member" &&
          entry.phase.broadcasterId === member.id
            ? { ...entry, expiresAt: Math.min(entry.expiresAt, cleanupAfter) }
            : entry,
        );

      return [{ ...member, cleanupAfter }];
    }

    if (member.cleanupAfter === null || member.cleanupAfter > now)
      return [member];

    if (
      state.grants[member.id]?.includes("channel:bot") ||
      state.sender?.id === member.id ||
      state.channels.some((channel) => channel.id === member.id)
    )
      return [{ ...member, cleanupAfter: null }];

    delete state.subscriptions[member.id];
    delete state.grants[member.id];

    return [];
  });
}

export function nextCleanup(state: AccountState): number | null {
  const due = Math.min(
    ...state.oauth.map((entry) => entry.expiresAt),
    ...state.enrollments.map((entry) => entry.expiresAt),
    ...state.publicMembers.map((member) => member.cleanupAfter ?? Infinity),
    ...Object.values(state.revoked).map(
      (entry) => entry.deleteDue ?? entry.until,
    ),
    ...Object.values(state.attempts).map((entry) => entry.retainUntil),
    ...state.reservations.map((entry) => entry.at + policy.globalWindowMs),
  );

  return Number.isFinite(due) ? due : null;
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
  state: Pick<AccountState, "channels" | "publicMembers" | "lifecycle">,
  senderKind: AccountIdentity["senderKind"],
) {
  const channels = new Map<string, AccountState["channels"][number]>(
    (senderKind === "bot" ? state.publicMembers : []).map((channel) => [
      channel.id,
      channel,
    ]),
  );

  for (const channel of state.channels) channels.set(channel.id, channel);

  return [...channels.values()].filter(
    (channel) => state.lifecycle[channel.id]?.kind !== "removed",
  );
}

export function nextAlarm(
  state: Pick<
    AccountState,
    | "repair"
    | "nextCredentialCheck"
    | "nextCleanupAt"
    | "nextRecoveryAt"
    | "sweepAt"
  >,
): number | null {
  const due = Math.min(
    state.nextRecoveryAt ?? Infinity,
    state.sweepAt ?? Infinity,
    state.nextCredentialCheck ?? Infinity,
    state.nextCleanupAt ?? Infinity,
  );

  return Number.isFinite(due) ? due : null;
}
