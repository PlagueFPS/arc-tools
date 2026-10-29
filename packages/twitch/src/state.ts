import {
  pipe,
  Context,
  HashMap,
  Effect,
  Option,
  Schema,
  Struct,
  Array as Arr,
  Record as Rec,
} from "effect";

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
  expiresAt: Schema.Finite,
  validatedAt: Schema.Finite,
  generation: Schema.String,
});

const Lease = Schema.Struct({ owner: Schema.String, until: Schema.Finite });

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
  expiresAt: Schema.Finite,
});

const Attempt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
    fingerprint: Schema.String,
    deadline: Schema.Finite,
    retainUntil: Schema.Finite,
    retryAt: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("sending"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
    fingerprint: Schema.String,
    deadline: Schema.Finite,
    retainUntil: Schema.Finite,
    owner: Schema.String,
    instance: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    channel: Schema.optional(BroadcasterId),
    source: Schema.optional(Schema.NullOr(ChatSource)),
    fingerprint: Schema.String,
    deadline: Schema.Finite,
    retainUntil: Schema.Finite,
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
  expiresAt: Schema.Finite,
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
    due: Schema.Finite,
    attempts: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("required") }),
]);

const legacyCleanupAt = 1;

const PublicMember = Schema.Struct({
  login: bounded(25),
  id: BroadcasterId,
  revocationGeneration: Schema.Int,
  cleanupAfter: Schema.NullOr(Schema.Finite).pipe(
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
      Schema.Struct({ due: Schema.Finite, stage: Schema.Int }),
    ),
    create: Schema.NullOr(
      Schema.Struct({ owner: Schema.String, until: Schema.Finite }),
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
  sweepAt: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  nextRecoveryAt: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  grants: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  oauth: Schema.Array(OAuthState),
  session: Schema.NullOr(Session),
  tokenLease: Schema.NullOr(Lease),
  tokenRetryAt: Schema.Finite,
  nextCredentialCheck: Schema.NullOr(Schema.Finite),
  nextCleanupAt: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(legacyCleanupAt)),
  ),
  setupLease: Schema.NullOr(
    Schema.Struct({
      owner: Schema.String,
      until: Schema.Finite,
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
      until: Schema.Finite,
      reason: Schema.Literals(["retired", "revoked", "authorization-revoked"]),
      deleteVersion: Schema.optional(Schema.Int),
      deleteClaim: Schema.optional(Schema.NullOr(bounded(128))),
      deleteDue: Schema.NullOr(Schema.Finite).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(null)),
      ),
    }),
  ),
  attempts: Schema.Record(Schema.String, Attempt),
  reservations: Schema.Array(
    Schema.Struct({ channel: Schema.String, at: Schema.Finite }),
  ),
  apiBlockedUntil: Schema.Finite,
  credentialFailures: Schema.Int,
});

// oxlint-disable-next-line effecttsgo/unnecessary-typeof-type -- This captures the schema type before the public mapped alias; using that alias here is circular.
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

  for (const [id, value] of Rec.toEntries(lifecycle))
    records.set(id, { ...entry(id), lifecycle: value });

  Arr.forEach(channels, (member, position) => {
    const prior = entry(member.id);
    records.set(member.id, {
      ...prior,
      configured: [...prior.configured, { position, member }],
    });
  });
  Arr.forEach(publicMembers, (member, position) => {
    const prior = entry(member.id);
    records.set(member.id, {
      ...prior,
      public: [...prior.public, { position, member }],
    });
  });

  for (const [key, subscription] of Rec.toEntries(subscriptions))
    records.set(key, { ...entry(key), subscription });

  return { shared, channels: records, revoked, oauth, attempts, enrollments };
}

export type AccountDirectory = ReturnType<typeof splitAccount>;

export class DirectoryValidationError extends Schema.TaggedError<
  DirectoryValidationError,
  { readonly brand: unique symbol }
>()("DirectoryValidationError", {
  reason: Schema.Literals(["positions", "key"]),
  message: Schema.String,
}) {}

export const joinDirectory = Effect.fnUntraced(function* (
  directory: AccountDirectory,
): Effect.fn.Return<AccountState, DirectoryValidationError> {
  const configured = Arr.flatMap(
    [...directory.channels.values()],
    (record) => record.configured,
  ).sort((a, b) => a.position - b.position);

  const members = Arr.flatMap(
    [...directory.channels.values()],
    (record) => record.public,
  ).sort((a, b) => a.position - b.position);

  for (const entries of [configured, members])
    if (Arr.some(entries, (entry, index) => !!(entry.position !== index)))
      return yield* new DirectoryValidationError({
        reason: "positions",
        message: "Conflicting channel membership positions",
      });

  for (const [key, record] of directory.channels)
    if (
      Arr.some(
        [...record.configured, ...record.public],
        (entry) => !!(entry.member.id !== key),
      )
    )
      return yield* new DirectoryValidationError({
        reason: "key",
        message: "Conflicting channel membership key",
      });

  return {
    ...directory.shared,
    lifecycle: Rec.fromEntries(
      Arr.flatMap([...directory.channels], ([id, record]) =>
        record.lifecycle === null ? [] : [[id, record.lifecycle]],
      ),
    ),
    channels: Arr.map(configured, (entry) => entry.member),
    publicMembers: Arr.map(members, (entry) => entry.member),
    subscriptions: Rec.fromEntries(
      Arr.flatMap([...directory.channels], ([key, record]) =>
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
  state.reservations = Arr.filter(
    state.reservations,
    (entry) => !!(entry.at + policy.globalWindowMs > now),
  );

  for (const [key, attempt] of Rec.toEntries(state.attempts)) {
    if (attempt.retainUntil <= now) delete state.attempts[key];
  }
}

export function reclaim(state: AccountState, now: number) {
  reclaimSend(state, now);
  state.oauth = Arr.filter(state.oauth, (entry) => !!(entry.expiresAt > now));
  state.enrollments = Arr.filter(
    state.enrollments,
    (entry) => !!(entry.expiresAt > now),
  );

  for (const [key, tombstone] of Rec.toEntries(state.revoked)) {
    if (tombstone.until <= now && tombstone.deleteDue === null)
      delete state.revoked[key];
  }

  state.publicMembers = Arr.flatMap(state.publicMembers, (member) => {
    if (member.cleanupAfter === legacyCleanupAt) {
      const record = state.subscriptions[member.id];

      const cleanupAfter =
        record &&
        isAuthorizationLoss(record.status) &&
        !state.grants[member.id]?.includes("channel:bot") &&
        state.sender?.id !== member.id &&
        !Arr.some(state.channels, (channel) => !!(channel.id === member.id))
          ? now + Math.max(policy.oauthMs, policy.retentionMs)
          : null;

      if (cleanupAfter !== null)
        state.enrollments = Arr.map(state.enrollments, (entry) =>
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
      Arr.some(state.channels, (channel) => !!(channel.id === member.id))
    )
      return [{ ...member, cleanupAfter: null }];

    delete state.subscriptions[member.id];
    delete state.grants[member.id];

    return [];
  });
}

export function nextCleanup(state: AccountState): Option.Option<number> {
  const due = Math.min(
    ...Arr.map(state.oauth, (entry) => entry.expiresAt),
    ...Arr.map(state.enrollments, (entry) => entry.expiresAt),
    ...Arr.map(
      state.publicMembers,
      (member) => member.cleanupAfter ?? Infinity,
    ),
    ...Arr.map(
      Rec.values(state.revoked),
      (entry) => entry.deleteDue ?? entry.until,
    ),
    ...Arr.map(Rec.values(state.attempts), (entry) => entry.retainUntil),
    ...Arr.map(state.reservations, (entry) => entry.at + policy.globalWindowMs),
  );

  return Number.isFinite(due) ? Option.some(due) : Option.none();
}

export function reserveAt(
  state: Pick<AccountState, "reservations" | "apiBlockedUntil">,
  channel: string,
  now: number,
): number {
  const recent = Arr.filter(
    state.reservations,
    (entry) => !!(entry.at + policy.globalWindowMs > now),
  );

  const oldest = recent[recent.length - policy.globalMessages];
  const global = oldest === undefined ? now : oldest.at + policy.globalWindowMs;

  const last = Arr.filter(recent, (entry) => !!(entry.channel === channel)).at(
    -1,
  );

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
  const candidates = [
    ...(senderKind === "bot" ? state.publicMembers : []),
    ...state.channels,
  ];

  const channels = pipe(
    candidates,
    Arr.map((channel) => [channel.id, channel] as const),
    HashMap.fromIterable,
  );

  const ids = pipe(
    candidates,
    Arr.map((channel) => channel.id),
    Arr.dedupe,
  );

  return Arr.flatMap(ids, (id) =>
    HashMap.get(channels, id).pipe(
      Option.filter(
        (channel) => state.lifecycle[channel.id]?.kind !== "removed",
      ),
      Option.toArray,
    ),
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
): Option.Option<number> {
  const due = Math.min(
    state.nextRecoveryAt ?? Infinity,
    state.sweepAt ?? Infinity,
    state.nextCredentialCheck ?? Infinity,
    state.nextCleanupAt ?? Infinity,
  );

  return Number.isFinite(due) ? Option.some(due) : Option.none();
}
