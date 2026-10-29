import { randomUUID as secureRandomUUID } from "@arctools/utils/http";
import { digest } from "@arctools/utils/http";
import {
  Context,
  Clock,
  Effect,
  Layer,
  Match,
  Result,
  Predicate,
  Schema,
  Semaphore,
  Array as Arr,
  Option,
  Record as Rec,
} from "effect";

import {
  AccountError,
  InstallationId,
  type ChatSource,
  type AccountStatus,
  Dispatch,
  EnrollmentBegin,
  EnrollmentCompletion,
  EnrollmentSession,
  type EnrollmentStatus,
  TwitchEnrollment,
  type DispatchOutcome,
  OAuthCompletion,
  type SetupResult,
  SubscriptionObservation,
  TwitchAccount,
} from "./contracts.js";
import { type Subscription, TwitchProvider } from "./provider.js";
import { BroadcasterId, Deadline } from "./schemas.js";
import {
  type AccountState,
  type SharedAccount,
  type ChannelDispatchState,
  AccountStore,
  desiredChannels,
  isAuthorizationLoss,
  policy,
  reclaim,
  reclaimSend,
  reserveAt,
} from "./state.js";

export const senderScopes = ["user:read:chat", "user:write:chat", "user:bot"];

export const broadcasterScopes = ["channel:bot"];

export interface AccountIdentity {
  readonly senderKind: "bot" | "personal" | "synthetic";
  readonly stage: string;
  readonly twitchClientId: string;
  readonly senderLogin: string;
  readonly channelLogins: readonly string[];
}

export interface AccountConfig {
  readonly identity: AccountIdentity;
  readonly revision: string;
  readonly callback: string;
  readonly redirect: string;
  readonly webhookReady: boolean;
  readonly subscriptionBinding: string;
}

const granted = (
  state: Pick<AccountState, "grants">,
  id: string,
  scopes: readonly string[],
) => Arr.every(scopes, (scope) => !!state.grants[id]?.includes(scope));

const CallbackUrl = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.port === "" || url.port === "443")
      );
    } catch {
      return false;
    }
  }),
);

const OAuthRedirectUrl = Schema.Union([
  CallbackUrl,
  Schema.Literal("http://localhost:3000/oauth/twitch/callback"),
]);

const liveSubscription = (status: string) =>
  status === "enabled" || status === "webhook_callback_verification_pending";

const lifecycleSnapshot = (state: Pick<AccountState, "lifecycle">) =>
  JSON.stringify(
    Arr.map(Rec.toEntries(state.lifecycle), ([id, life]) => [
      id,
      life.kind === "installed" ? { ...life, recovery: null } : life,
    ]),
  );

export const makeAccount = Effect.fnUntraced(function* (config: AccountConfig) {
  const store = yield* AccountStore;
  const provider = yield* TwitchProvider;
  const tokenLock = yield* Semaphore.make(1);
  const gates = new Map<string, { lock: Semaphore.Semaphore; users: number }>();

  const gated = Effect.fnUntraced(function* <A, E, R>(
    id: string,
    operation: Effect.Effect<A, E, R>,
  ) {
    let gate = gates.get(id);

    if (!gate) {
      gate = { lock: yield* Semaphore.make(1), users: 0 };
      gates.set(id, gate);
    }

    const entry = gate;
    entry.users++;

    return yield* operation.pipe(
      (effect) => entry.lock.withPermit(effect),
      Effect.ensuring(
        Effect.sync(() => {
          entry.users--;

          if (entry.users === 0) gates.delete(id);
        }),
      ),
    );
  });

  const gatedChannels = <A, E, R>(
    ids: readonly string[],
    operation: Effect.Effect<A, E, R>,
  ) =>
    Arr.reduceRight(Arr.dedupe(ids).sort(), operation, (next, id) =>
      gated(id, next),
    );

  const instance = yield* secureRandomUUID;
  let validatedGeneration = "";

  const current = (state: Pick<AccountState, "revision">) =>
    state.revision === config.revision;

  const matchesTarget = (
    state: Pick<
      AccountState,
      "revision" | "channels" | "publicMembers" | "sender" | "lifecycle"
    >,
    record: AccountState["subscriptions"][string],
  ) =>
    current(state) &&
    Arr.some(
      desiredChannels(state, config.identity.senderKind),
      (channel) => !!(channel.id === record.broadcasterId),
    ) &&
    state.sender?.id === record.senderId &&
    record.callback === config.callback &&
    record.binding === config.subscriptionBinding;

  const decideChannel = (state: ChannelDispatchState, id: string) => {
    const record = state.subscriptions[id];

    const confirmed =
      Predicate.isNotUndefined(record) &&
      record.broadcasterId === id &&
      matchesTarget(state, record) &&
      !state.revoked[record.id];

    const subscription = Predicate.isUndefined(record)
      ? "missing"
      : !confirmed
        ? "obsolete"
        : record.status;

    let kind: AccountStatus["setup"];

    if (
      !current(state) ||
      !state.sender ||
      !Arr.some(
        desiredChannels(state, config.identity.senderKind),
        (channel) => !!(channel.id === id),
      )
    )
      kind = "unresolved";
    else if (record && (!confirmed || !liveSubscription(record.status)))
      kind = "repair-required";
    else if (
      !granted(state, state.sender.id, senderScopes) ||
      !granted(state, id, broadcasterScopes)
    )
      kind = "authorization-required";
    else if (!config.webhookReady) kind = "ingress-required";
    else kind = confirmed && record.status === "enabled" ? "ready" : "pending";

    return {
      kind,
      subscription,
      confirmed: confirmed && liveSubscription(record.status),
    };
  };

  const ownsSetup = (
    state: AccountState,
    owner: string,
    generation: number,
    now: number,
  ) =>
    current(state) &&
    state.authGeneration === generation &&
    state.setupLease?.owner === owner &&
    state.setupLease.revision === config.revision &&
    state.setupLease.generation === generation &&
    state.setupLease.until > now;

  const retireId = (state: AccountState, id: string, now: number) => {
    const prior = state.revoked[id];
    state.revoked[id] = {
      until: Math.max(prior?.until ?? 0, now + policy.revocationMs),
      reason: prior?.reason ?? "retired",
      deleteDue: prior?.deleteDue ?? now + 1,
      deleteVersion: (prior?.deleteVersion ?? 0) + 1,
      deleteClaim: null,
    };
  };

  const recover = (state: AccountState, id: string, now: number) => {
    const value = state.lifecycle[id];

    if (value?.kind !== "installed" || value.recovery) return;
    state.lifecycle[id] = {
      ...value,
      version: value.version + 1,
      recovery: { due: now + 60_000, stage: 1 },
    };
  };

  const removeChannel = (state: AccountState, id: string, now: number) => {
    if (state.lifecycle[id]?.kind === "removed") return;
    state.publicRevocationGeneration++;
    state.lifecycle[id] = {
      kind: "removed",
      sequence: state.publicRevocationGeneration,
    };
    const record = state.subscriptions[id];

    if (record) retireId(state, record.id, now);
    delete state.subscriptions[id];

    const login = Arr.findFirst(
      desiredChannels(state, config.identity.senderKind),
      (member) => member.id === id,
    ).pipe(
      Option.orElse(() =>
        Arr.findFirst(state.publicMembers, (member) => member.id === id),
      ),
      Option.orElse(() =>
        Arr.findFirst(state.channels, (member) => member.id === id),
      ),
      Option.map((member) => member.login),
      Option.getOrElse(() => "channel"),
    );

    state.channels = Arr.filter(
      state.channels,
      (member) => !!(member.id !== id),
    );
    state.publicMembers = Arr.filter(
      state.publicMembers,
      (member) => !!(member.id !== id),
    );

    const scopes = Arr.filter(
      state.grants[id] ?? [],
      (scope) => !!(scope !== "channel:bot"),
    );

    if (scopes.length) state.grants[id] = scopes;
    else delete state.grants[id];

    for (const [key, attempt] of Rec.toEntries(state.attempts))
      if (attempt.channel === id && attempt.kind === "waiting")
        state.attempts[key] = {
          ...attempt,
          kind: "terminal",
          outcome: { kind: "rejected" },
          privateCode: "removed",
        };
    state.oauth = Arr.filter(state.oauth, (entry) => !!(entry.userId !== id));
    state.setupLease = null;
    state.enrollments = Arr.map(state.enrollments, (entry) =>
      entry.phase.kind === "member" && entry.phase.broadcasterId === id
        ? {
            ...entry,
            phase: {
              kind: "left",
              broadcasterId: BroadcasterId.make(id),
              login,
            },
          }
        : entry,
    );
  };

  const revokeSubscription = (
    state: AccountState,
    observation: Pick<
      AccountState["subscriptions"][string],
      "id" | "broadcasterId" | "senderId" | "status"
    >,
    now: number,
  ) => {
    const record = state.subscriptions[observation.broadcasterId];

    if (
      !record ||
      record.id !== observation.id ||
      !matchesTarget(state, record)
    )
      return;

    if (isAuthorizationLoss(observation.status)) {
      const login = Arr.findFirst(
        desiredChannels(state, config.identity.senderKind),
        (member) => member.id === observation.broadcasterId,
      ).pipe(
        Option.map((member) => member.login),
        Option.getOrElse(() => "channel"),
      );

      removeChannel(state, observation.broadcasterId, now);
      state.enrollments = Arr.map(state.enrollments, (entry) =>
        entry.phase.kind === "left" &&
        entry.phase.broadcasterId === observation.broadcasterId
          ? { ...entry, phase: { ...entry.phase, login } }
          : entry,
      );
      state.revoked[observation.id] = {
        until: now + policy.revocationMs,
        reason: "authorization-revoked",
        deleteDue: now + 1,
        deleteVersion: (state.revoked[observation.id]?.deleteVersion ?? 0) + 1,
        deleteClaim: null,
      };
    } else {
      state.subscriptions[observation.broadcasterId] = {
        ...record,
        status: observation.status,
      };
      recover(state, observation.broadcasterId, now);
    }
  };

  if (!(yield* store.shared(current)))
    yield* store.update((state) => {
      if (!current(state)) {
        state.revision = config.revision;
        state.authGeneration += 1;
        state.sender = null;
        state.channels = [];
        state.grants = {};
        state.oauth = [];
        state.enrollments = Arr.map(state.enrollments, (entry) =>
          entry.phase.kind === "left"
            ? entry
            : {
                ...entry,
                phase: { kind: "failed", reason: "authorization-required" },
              },
        );
        state.repair = { kind: "idle" };
        state.session = null;
        state.setupLease = null;
        state.tokenLease = null;
        state.tokenRetryAt = 0;
        state.credentialFailures = 0;
        state.nextCredentialCheck = null;
      }
    });

  const startedMigrationAt = yield* Clock.currentTimeMillis;

  if ((yield* store.shared((state) => state.lifecycleVersion)) < 1)
    yield* store.update((state) => {
      state.lifecycleVersion = 1;

      for (const channel of desiredChannels(
        state,
        config.identity.senderKind,
      )) {
        if (!state.lifecycle[channel.id])
          state.lifecycle[channel.id] = {
            kind: "installed",
            // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The atomic state-update callback allocates a fresh secure ID synchronously for each new installation.
            id: InstallationId.make(crypto.randomUUID()),
            negative: null,
            sequence: 0,
            version: 0,
            create: null,
            recovery:
              state.subscriptions[channel.id]?.status === "enabled"
                ? null
                : { due: startedMigrationAt + 1, stage: 0 },
          };
      }

      state.repair = { kind: "idle" };

      if (state.sender) state.sweepAt ??= startedMigrationAt + policy.sweepMs;

      for (const record of Rec.values(state.subscriptions))
        if (
          isAuthorizationLoss(record.status) &&
          !granted(state, record.broadcasterId, broadcasterScopes)
        )
          revokeSubscription(state, record, startedMigrationAt);
    });

  const invalidateSession = (state: SharedAccount, generation: string) => {
    if (current(state) && state.session?.generation === generation) {
      state.session = null;
      state.tokenLease = null;
      state.tokenRetryAt = 0;
      state.nextCredentialCheck = null;
    }
  };

  const invalidate = (generation: string) =>
    store.shared((state) => invalidateSession(state, generation));

  const appToken = Effect.fn("TwitchAccount.token")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const owner = yield* secureRandomUUID;

      const claim = yield* store.shared((state) => {
        if (!current(state)) return { kind: "stale" } as const;
        const session = state.session;

        if (
          session &&
          session.expiresAt > now + 5_000 &&
          session.validatedAt + policy.hourlyMs > now &&
          validatedGeneration === session.generation
        ) {
          state.nextCredentialCheck = Math.min(
            session.validatedAt + policy.hourlyMs,
            session.expiresAt - 5_000,
          );

          return { kind: "cached", session } as const;
        }

        if (
          state.tokenRetryAt > now ||
          (state.tokenLease && state.tokenLease.until > now)
        )
          return { kind: "busy" } as const;
        state.tokenLease = { owner, until: now + policy.tokenLeaseMs };
        state.nextCredentialCheck = now + policy.tokenLeaseMs;

        return { kind: "claim", session } as const;
      });

      return yield* Match.value(claim).pipe(
        Match.discriminatorsExhaustive("kind")({
          stale: () => new AccountError({ code: "stale" }),
          busy: () => new AccountError({ code: "busy" }),
          cached: ({ session }) => Effect.succeed(session),
          claim: (claim) => {
            const acquire = Effect.fnUntraced(function* () {
              let token = claim.session?.token;

              if (!claim.session || claim.session.expiresAt <= now + 5_000)
                token = (yield* provider.mint).access_token;

              if (!token) return yield* new AccountError({ code: "provider" });
              const validation = yield* provider.validate(token);

              if (
                validation.client_id !== config.identity.twitchClientId ||
                Predicate.isNotUndefined(validation.user_id)
              )
                return yield* new AccountError({ code: "client" });

              if (validation.expires_in <= 5)
                return yield* new AccountError({ code: "client" });
              const completed = yield* Clock.currentTimeMillis;

              const session = {
                token,
                expiresAt: completed + validation.expires_in * 1000,
                validatedAt: completed,
                generation:
                  claim.session?.token === token
                    ? claim.session.generation
                    : owner,
              };

              const accepted = yield* store.shared((state) => {
                if (
                  !current(state) ||
                  state.tokenLease?.owner !== owner ||
                  state.session?.generation !== claim.session?.generation
                )
                  return false;
                state.session = session;
                state.tokenLease = null;
                state.tokenRetryAt = 0;
                state.credentialFailures = 0;
                state.nextCredentialCheck = Math.min(
                  completed + policy.hourlyMs,
                  session.expiresAt - 5_000,
                );

                return true;
              });

              if (!accepted) return yield* new AccountError({ code: "stale" });
              validatedGeneration = session.generation;

              return session;
            });

            return acquire().pipe(
              Effect.tapError(() =>
                store.shared((state) => {
                  if (current(state) && state.tokenLease?.owner === owner) {
                    state.tokenLease = null;
                    state.session = null;
                    state.tokenRetryAt = now + 5_000;
                    state.credentialFailures += 1;
                    state.nextCredentialCheck =
                      state.credentialFailures < 3 ? now + 60_000 : null;
                  }
                }),
              ),
            );
          },
        }),
      );
    },
    (effect) => effect.pipe((effect) => tokenLock.withPermit(effect)),
  );

  const startedAt = yield* Clock.currentTimeMillis;
  yield* store.shared((state) => {
    if (
      current(state) &&
      (Predicate.isNotNull(state.session) ||
        Predicate.isNotNull(state.tokenLease))
    )
      state.nextCredentialCheck = startedAt + 1;
  });

  const status = Effect.gen(function* (): Effect.fn.Return<
    AccountStatus,
    AccountError
  > {
    const now = yield* Clock.currentTimeMillis;

    const result = yield* store.update((state) => {
      reclaim(state, now);

      const decisions = Arr.map(
        desiredChannels(state, config.identity.senderKind),
        (channel) => decideChannel(state, channel.id),
      );

      const channels = Arr.map(
        desiredChannels(state, config.identity.senderKind),
        (channel, index) => ({
          ...channel,
          authorized: granted(state, channel.id, broadcasterScopes),
          subscription: decisions[index]?.subscription ?? "missing",
        }),
      );

      const sender = state.sender && {
        ...state.sender,
        authorized: granted(state, state.sender.id, senderScopes),
      };

      const setup: AccountStatus["setup"] = !sender
        ? "unresolved"
        : (Option.getOrUndefined(
            Arr.findFirst(
              [
                "unresolved",
                "repair-required",
                "authorization-required",
                "ingress-required",
                "pending",
              ] satisfies AccountStatus["setup"][],
              (kind) =>
                !!Arr.some(decisions, (decision) => !!(decision.kind === kind)),
            ),
          ) ?? "ready");

      return {
        stage: config.identity.stage,
        revision: state.revision,
        setup,
        sender,
        channels,
        credential: Predicate.isNull(state.session)
          ? "absent"
          : validatedGeneration === state.session.generation &&
              state.session.expiresAt > now &&
              state.session.validatedAt + policy.hourlyMs > now
            ? "valid"
            : "validation-required",
        attempts: Rec.keys(state.attempts).length,
        credentialCheckAt: state.session?.validatedAt ?? null,
      } satisfies AccountStatus;
    });

    if (result.revision !== config.revision)
      return yield* new AccountError({ code: "stale" });

    return result;
  });

  const deleteObligation = Effect.fnUntraced(function* (
    token: string,
    id: string,
  ) {
    const now = yield* Clock.currentTimeMillis;

    const owner = yield* secureRandomUUID;

    const claim = yield* store.update((state) => {
      const entry = state.revoked[id];

      if (
        !entry ||
        entry.deleteDue === null ||
        state.apiBlockedUntil > now ||
        Arr.some(
          Rec.values(state.subscriptions),
          (record) =>
            !!(
              record.id === id &&
              liveSubscription(record.status) &&
              matchesTarget(state, record)
            ),
        )
      )
        return null;
      state.revoked[id] = { ...entry, deleteClaim: owner };

      return entry.deleteVersion ?? 0;
    });

    if (claim === null) return;

    const credentialGeneration = yield* store.shared((state) =>
      state.session?.token === token ? state.session.generation : null,
    );

    yield* provider.remove(token, id).pipe(
      Effect.tap(() =>
        store.update((state) => {
          const entry = state.revoked[id];

          if (
            entry?.deleteClaim === owner &&
            (entry.deleteVersion ?? 0) === claim
          )
            state.revoked[id] = {
              ...entry,
              deleteDue: null,
              deleteClaim: null,
            };
        }),
      ),
      Effect.catch((error) =>
        store.update((state) => {
          const entry = state.revoked[id];

          if (error.code === "client" && credentialGeneration !== null)
            invalidateSession(state, credentialGeneration);

          if (error.retryAt)
            state.apiBlockedUntil = Math.max(
              state.apiBlockedUntil,
              error.retryAt,
            );

          if (
            entry?.deleteClaim === owner &&
            (entry.deleteVersion ?? 0) === claim
          )
            state.revoked[id] = {
              ...entry,
              deleteDue: Math.max(now + 60_000, state.apiBlockedUntil),
              deleteClaim: null,
            };
        }),
      ),
    );
  });

  const cleanupRemote = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (
      !(yield* store.shared(
        (state) =>
          (state.nextCleanupAt !== null && state.nextCleanupAt <= now) ||
          (state.sweepAt !== null && state.sweepAt <= now),
      ))
    )
      return;

    const sweepOwner = yield* secureRandomUUID;

    const work = yield* store.update((state) => {
      const sweep =
        current(state) &&
        state.sweepAt !== null &&
        state.sweepAt <= now &&
        state.apiBlockedUntil <= now &&
        (!state.sweepLease || state.sweepLease.until <= now);

      if (sweep)
        state.sweepLease = {
          owner: sweepOwner,
          until: now + policy.setupLeaseMs,
        };
      else if (state.sweepAt !== null && state.sweepAt <= now)
        state.sweepAt = Math.max(
          now + 1,
          state.apiBlockedUntil,
          (state.sweepLease?.until ?? now) + 1,
        );

      return {
        ids: Arr.map(
          Arr.filter(
            Rec.toEntries(state.revoked),
            ([, entry]) =>
              !!(entry.deleteDue !== null && entry.deleteDue <= now),
          )
            .sort((a, b) => (a[1].deleteDue ?? 0) - (b[1].deleteDue ?? 0))
            .slice(0, 4),
          ([id]) => id,
        ),
        sweep,
        versions: lifecycleSnapshot(state),
      };
    });

    if (!work.ids.length && !work.sweep) return;
    yield* store.update((state) => {
      for (const id of work.ids) {
        const entry = state.revoked[id];

        if (entry)
          state.revoked[id] = {
            ...entry,
            deleteDue: Math.max(now + 60_000, state.apiBlockedUntil),
          };
      }

      if (work.sweep)
        state.sweepAt = Math.max(now + policy.sweepMs, state.apiBlockedUntil);
    });
    yield* Effect.gen(function* () {
      const session = yield* appToken();

      for (const id of work.ids) yield* deleteObligation(session.token, id);

      if (!work.sweep) return;
      const listingAt = yield* Clock.currentTimeMillis;

      const canList = yield* store.shared((state) => {
        state.sweepAt = Math.max(
          listingAt + policy.sweepMs,
          state.apiBlockedUntil,
        );

        return state.apiBlockedUntil <= listingAt;
      });

      if (!canList) return;

      const remote = yield* provider
        .list(session.token)
        .pipe(
          Effect.tapError((error) =>
            error.code === "client"
              ? invalidate(session.generation)
              : Effect.void,
          ),
        );

      for (const record of remote) {
        const id = record.condition.broadcaster_user_id;

        if (
          !id ||
          record.type !== "channel.chat.message" ||
          record.version !== "1" ||
          record.transport.method !== "webhook" ||
          record.transport.callback !== config.callback
        )
          continue;
        yield* gated(
          id,
          Effect.gen(function* () {
            const observedAt = yield* Clock.currentTimeMillis;

            yield* store.update((state) => {
              if (
                !current(state) ||
                state.sweepLease?.owner !== sweepOwner ||
                state.sweepLease.until <= observedAt ||
                lifecycleSnapshot(state) !== work.versions ||
                state.sender?.id !== record.condition.user_id
              )
                return false;
              const life = state.lifecycle[id];

              if (
                life?.kind === "installed" &&
                life.create &&
                life.create.until > now
              )
                return false;

              if (
                Arr.some(
                  Rec.values(state.subscriptions),
                  (local) =>
                    !!(
                      local.id === record.id &&
                      liveSubscription(local.status) &&
                      matchesTarget(state, local)
                    ),
                )
              )
                return false;
              retireId(state, record.id, now);

              return true;
            });
          }),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        store.shared((state) => {
          if (error.retryAt)
            state.apiBlockedUntil = Math.max(
              state.apiBlockedUntil,
              error.retryAt,
            );

          if (work.sweep)
            state.sweepAt = Math.max(now + 60_000, state.apiBlockedUntil);
        }),
      ),
      Effect.ensuring(
        store.shared((state) => {
          if (state.sweepLease?.owner === sweepOwner) state.sweepLease = null;
        }),
      ),
    );
  });

  const reconcile = Effect.fnUntraced(function* (
    owner: string,
    token: string,
    sender: string,
    channels: readonly string[],
    generation: number,
  ) {
    const assertOwner = Effect.fnUntraced(function* () {
      const now = yield* Clock.currentTimeMillis;

      const valid = yield* store.update((state) =>
        ownsSetup(state, owner, generation, now),
      );

      if (!valid) return yield* new AccountError({ code: "stale" });
      const blocked = yield* store.shared((state) => state.apiBlockedUntil);

      if (blocked > now)
        return yield* new AccountError({ code: "provider", retryAt: blocked });
    });

    const sameRemote = (
      record: AccountState["subscriptions"][string],
      subscription: Subscription,
    ) =>
      subscription.id === record.id &&
      subscription.type === "channel.chat.message" &&
      subscription.version === "1" &&
      subscription.transport.method === "webhook" &&
      subscription.transport.callback === record.callback &&
      subscription.condition.broadcaster_user_id === record.broadcasterId &&
      subscription.condition.user_id === record.senderId;

    const retire = Effect.fnUntraced(function* (id: string) {
      const clock = yield* Clock.Clock;

      const broadcaster = yield* store.update(
        (state) =>
          Option.getOrUndefined(
            Arr.findFirst(
              Rec.values(state.subscriptions),
              (record) => !!(record.id === id),
            ),
          )?.broadcasterId ??
          Option.getOrUndefined(
            Arr.findFirst(remote, (record) => !!(record.id === id)),
          )?.condition.broadcaster_user_id ??
          id,
      );

      const retired = yield* gated(
        broadcaster,
        store.update((state) => {
          const now = clock.currentTimeMillisUnsafe();

          if (!ownsSetup(state, owner, generation, now)) return false;
          retireId(state, id, now);

          for (const [channel, record] of Rec.toEntries(state.subscriptions))
            if (record.id === id) {
              const life = state.lifecycle[channel];

              if (life?.kind === "installed" && matchesTarget(state, record))
                state.lifecycle[channel] = {
                  ...life,
                  negative: {
                    ...record,
                    broadcasterId: BroadcasterId.make(record.broadcasterId),
                  },
                };
              delete state.subscriptions[channel];
              recover(state, channel, now);
            }

          return true;
        }),
      );

      if (!retired) return yield* new AccountError({ code: "stale" });

      if (channels.includes(broadcaster)) {
        yield* assertOwner();
        yield* deleteObligation(token, id);
      }
    });

    yield* assertOwner();

    const snapshot = yield* store.update((state) => ({
      versions: lifecycleSnapshot(state),
      channels: Rec.keys(state.lifecycle),
    }));

    const versions = snapshot.versions;
    const remote = yield* provider.list(token);
    const clock = yield* Clock.Clock;

    const cleanup = yield* gatedChannels(
      [
        ...snapshot.channels,
        ...Arr.flatMap(remote, (record) =>
          record.condition.broadcaster_user_id
            ? [record.condition.broadcaster_user_id]
            : [],
        ),
      ],
      store.update((state) => {
        const now = clock.currentTimeMillisUnsafe();

        if (
          !ownsSetup(state, owner, generation, now) ||
          lifecycleSnapshot(state) !== versions
        )
          return Option.none<readonly string[]>();
        const ids: string[] = [];

        for (const subscription of remote) {
          const managed =
            subscription.type === "channel.chat.message" &&
            subscription.version === "1" &&
            subscription.transport.method === "webhook" &&
            !!subscription.condition.broadcaster_user_id &&
            !!subscription.condition.user_id &&
            Predicate.isNotUndefined(subscription.transport.callback);

          if (!managed) continue;
          const channel = subscription.condition.broadcaster_user_id ?? "";
          const record = state.subscriptions[channel];

          const owned =
            state.revoked[subscription.id]?.deleteDue != null ||
            Arr.some(
              Rec.values(state.subscriptions),
              (local) => !!sameRemote(local, subscription),
            );

          const currentBinding =
            subscription.transport.callback === config.callback &&
            subscription.condition.user_id === state.sender?.id;

          if (!owned && !currentBinding) continue;

          if (
            record &&
            sameRemote(record, subscription) &&
            matchesTarget(state, record) &&
            isAuthorizationLoss(subscription.status)
          )
            revokeSubscription(
              state,
              { ...record, status: subscription.status },
              now,
            );

          if (
            record &&
            sameRemote(record, subscription) &&
            matchesTarget(state, record) &&
            !state.revoked[record.id] &&
            liveSubscription(record.status) &&
            liveSubscription(subscription.status)
          ) {
            state.subscriptions[channel] = {
              ...record,
              status:
                record.status === "enabled" ? "enabled" : subscription.status,
            };
          } else ids.push(subscription.id);
        }

        for (const record of Rec.values(state.subscriptions)) {
          if (
            !matchesTarget(state, record) ||
            !liveSubscription(record.status) ||
            state.revoked[record.id] ||
            !Arr.some(
              remote,
              (subscription) => !!sameRemote(record, subscription),
            )
          )
            ids.push(record.id);
        }

        return Option.some(Arr.dedupe(ids));
      }),
    );

    if (Option.isNone(cleanup))
      return yield* new AccountError({ code: "stale" });

    for (const id of cleanup.value) yield* retire(id);

    for (const channel of channels) {
      const now = yield* Clock.currentTimeMillis;

      const action = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, now)) return "stale";

        if (
          !state.sender ||
          !granted(state, state.sender.id, senderScopes) ||
          !granted(state, channel, broadcasterScopes) ||
          !Arr.some(
            desiredChannels(state, config.identity.senderKind),
            (entry) => !!(entry.id === channel),
          )
        )
          return "keep";

        return decideChannel(state, channel).confirmed ? "keep" : "create";
      });

      if (action === "stale") return yield* new AccountError({ code: "stale" });

      if (action === "keep") continue;
      yield* gated(
        channel,
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;

          const intent = yield* store.update((state) => {
            const life = state.lifecycle[channel];

            if (
              !ownsSetup(state, owner, generation, started) ||
              state.apiBlockedUntil > started ||
              life?.kind !== "installed" ||
              !Arr.some(
                desiredChannels(state, config.identity.senderKind),
                (entry) => !!(entry.id === channel),
              )
            )
              return null;
            state.lifecycle[channel] = {
              ...life,
              version: life.version + 1,
              create: { owner, until: started + policy.tokenLeaseMs },
            };
            state.sweepAt ??= started + policy.sweepMs;

            return life.id;
          });

          if (!intent) return;

          const result = yield* provider
            .create(token, channel, sender)
            .pipe(Effect.result);

          const completed = yield* Clock.currentTimeMillis;

          const accepted = yield* store.update((state) => {
            const life = state.lifecycle[channel];

            const owns =
              ownsSetup(state, owner, generation, completed) &&
              life?.kind === "installed" &&
              life.id === intent &&
              life.create?.owner === owner &&
              life.create.until > completed;

            if (life?.kind === "installed" && life.create?.owner === owner)
              state.lifecycle[channel] = {
                ...life,
                version: life.version + 1,
                create: null,
              };

            if (Result.isSuccess(result) && result.success.kind === "created") {
              const record = result.success.subscription;

              if (
                owns &&
                record.broadcasterId === channel &&
                matchesTarget(state, record) &&
                !state.revoked[record.id]
              ) {
                state.subscriptions[channel] = record;
                const priorLife = state.lifecycle[channel];

                if (priorLife?.kind === "installed")
                  state.lifecycle[channel] = { ...priorLife, negative: null };
                const currentLife = state.lifecycle[channel];

                if (
                  currentLife?.kind === "installed" &&
                  record.status === "enabled"
                )
                  state.lifecycle[channel] = { ...currentLife, recovery: null };
              } else {
                if (
                  owns &&
                  state.revoked[record.id]?.reason ===
                    "authorization-revoked" &&
                  matchesTarget(state, record)
                )
                  removeChannel(state, channel, completed);
                retireId(state, record.id, completed);
              }
            }

            if (Result.isFailure(result) && result.failure.retryAt)
              state.apiBlockedUntil = Math.max(
                state.apiBlockedUntil,
                result.failure.retryAt,
              );

            return owns;
          });

          if (Result.isFailure(result)) return yield* result.failure;

          if (!accepted) return yield* new AccountError({ code: "stale" });
        }),
      );
    }
  });

  const setup = Effect.fn("TwitchAccount.setup")(function* (
    operator: string,
  ): Effect.fn.Return<SetupResult, AccountError> {
    if (
      config.identity.channelLogins.length > policy.maxChannels ||
      !Schema.is(CallbackUrl)(config.callback) ||
      !Schema.is(OAuthRedirectUrl)(config.redirect)
    )
      return yield* new AccountError({ code: "configuration" });
    const now = yield* Clock.currentTimeMillis;
    const owner = yield* secureRandomUUID;

    const claimed = yield* store.update((state) => {
      reclaim(state, now);

      if (!current(state) || (state.setupLease && state.setupLease.until > now))
        return null;
      state.setupLease = {
        owner,
        until: now + policy.setupLeaseMs,
        revision: config.revision,
        generation: state.authGeneration,
      };

      return state.setupLease;
    });

    if (!claimed) return yield* new AccountError({ code: "busy" });
    const generation = claimed.generation;

    const run = Effect.fnUntraced(function* () {
      const session = yield* appToken();

      const authenticated = Effect.fnUntraced(function* <A>(
        operation: Effect.Effect<A, AccountError>,
      ) {
        return yield* operation.pipe(
          Effect.tapError((error) =>
            error.code === "client"
              ? invalidate(session.generation)
              : Effect.void,
          ),
        );
      });

      const logins = Arr.dedupe([
        config.identity.senderLogin,
        ...config.identity.channelLogins,
      ]);

      const users = yield* authenticated(provider.users(session.token, logins));

      const sender = yield* Arr.findFirst(
        users,
        (user) => user.login === config.identity.senderLogin,
      ).pipe((value) =>
        Effect.fromOption(value, () => new AccountError({ code: "identity" })),
      );

      const resolved = yield* Effect.forEach(
        config.identity.channelLogins,
        (login) =>
          Arr.findFirst(users, (user) => user.login === login).pipe(
            (value) =>
              Effect.fromOption(
                value,
                () => new AccountError({ code: "identity" }),
              ),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ login: Schema.String, id: BroadcasterId }),
              ),
            ),
            Effect.mapError(() => new AccountError({ code: "identity" })),
          ),
      );

      const resolvedAt = yield* Clock.currentTimeMillis;

      const accepted = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, resolvedAt)) return "stale";

        if (
          desiredChannels(
            {
              channels: resolved,
              publicMembers: state.publicMembers,
              lifecycle: state.lifecycle,
            },
            config.identity.senderKind,
          ).length > policy.maxChannels
        )
          return "capacity";
        state.sender = sender;
        state.channels = Arr.filter(
          resolved,
          (channel) => !!(state.lifecycle[channel.id]?.kind !== "removed"),
        );

        for (const channel of resolved)
          if (!state.lifecycle[channel.id])
            state.lifecycle[channel.id] = {
              kind: "installed",
              // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The atomic state-update callback allocates a fresh secure ID synchronously for each new installation.
              id: InstallationId.make(crypto.randomUUID()),
              negative: null,
              sequence: 0,
              version: 0,
              recovery:
                granted(state, sender.id, senderScopes) &&
                granted(state, channel.id, broadcasterScopes)
                  ? { due: resolvedAt + 1, stage: 0 }
                  : null,
              create: null,
            };

        return "accepted";
      });

      if (accepted !== "accepted")
        return yield* new AccountError({ code: accepted });
      const authorizations: SetupResult["authorizations"][number][] = [];
      const states: AccountState["oauth"][number][] = [];

      for (const user of users) {
        const roles: ("sender" | "broadcaster")[] = [];
        const scopes: string[] = [];

        if (user.id === sender.id) {
          roles.push("sender");
          scopes.push(...senderScopes);
        }

        if (Arr.some(resolved, (channel) => !!(channel.id === user.id))) {
          roles.push("broadcaster");
          scopes.push(...broadcasterScopes);
        }

        if (roles.length === 0) continue;

        const needed = yield* store.update(
          (state) => !granted(state, user.id, scopes),
        );

        if (!needed) continue;
        const nonce = `${yield* secureRandomUUID}${yield* secureRandomUUID}`;
        const hash = yield* digest(nonce);
        states.push({
          digest: hash,
          operator,
          revision: config.revision,
          generation,
          removalSequence: yield* store.update(
            (state) => state.lifecycle[user.id]?.sequence ?? 0,
          ),
          userId: user.id,
          login: user.login,
          roles,
          scopes,
          expiresAt: now + policy.oauthMs,
        });

        const params = new URLSearchParams({
          client_id: config.identity.twitchClientId,
          redirect_uri: config.redirect,
          response_type: "code",
          scope: Arr.join(scopes, " "),
          state: nonce,
          force_verify: "true",
        });

        authorizations.push({
          login: user.login,
          roles,
          url: `https://id.twitch.tv/oauth2/authorize?${params}`,
        });
      }

      const allocatedAt = yield* Clock.currentTimeMillis;

      const stored = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, allocatedAt)) return "stale";
        reclaim(state, allocatedAt);

        state.oauth = Arr.filter(
          state.oauth,
          (entry) => !granted(state, entry.userId, entry.scopes),
        );

        const retained =
          state.oauth.length + states.length <= policy.maxOAuth
            ? state.oauth
            : Arr.filter(
                state.oauth,
                (entry) =>
                  !!(
                    entry.operator === operator &&
                    entry.revision === config.revision &&
                    entry.generation === generation &&
                    !granted(state, entry.userId, entry.scopes) &&
                    !Arr.some(
                      states,
                      (next) => !!(next.userId === entry.userId),
                    )
                  ),
              );

        if (retained.length + states.length > policy.maxOAuth)
          return "capacity";
        state.oauth = [...retained, ...states];

        return "stored";
      });

      if (stored !== "stored") return yield* new AccountError({ code: stored });

      if (authorizations.length === 0 && config.webhookReady) {
        yield* authenticated(
          reconcile(
            owner,
            session.token,
            sender.id,
            yield* store.update((state) =>
              Arr.map(
                Arr.filter(
                  desiredChannels(state, config.identity.senderKind),
                  (channel) => {
                    const decision = decideChannel(state, channel.id);

                    return (
                      decision.kind === "pending" ||
                      decision.kind === "ready" ||
                      (decision.kind === "repair-required" &&
                        granted(state, channel.id, broadcasterScopes))
                    );
                  },
                ),
                (channel) => channel.id,
              ),
            ),
            generation,
          ),
        );
      }

      return { status: yield* status, authorizations };
    });

    return yield* run().pipe(
      Effect.ensuring(
        store.update((state) => {
          if (current(state) && state.setupLease?.owner === owner)
            state.setupLease = null;
        }),
      ),
    );
  });

  const completeOAuth = Effect.fn("TwitchAccount.oauth")(function* (
    input: OAuthCompletion,
  ) {
    const valid = yield* Schema.decodeEffect(OAuthCompletion)(input).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    const now = yield* Clock.currentTimeMillis;
    const hash = yield* digest(valid.state);

    const state = yield* store.update((account) => {
      const found = Arr.findFirst(
        account.oauth,
        (entry) => entry.digest === hash,
      );

      account.oauth = Arr.filter(
        account.oauth,
        (entry) => !!(entry.digest !== hash && entry.expiresAt > now),
      );

      return found;
    });

    if (
      Option.isNone(state) ||
      state.value.expiresAt <= now ||
      state.value.operator !== valid.operator ||
      state.value.revision !== config.revision
    )
      return yield* new AccountError({ code: "state" });
    const token = yield* provider.exchange(valid.code);
    const grant = yield* provider.validate(token.access_token);

    if (grant.client_id !== config.identity.twitchClientId)
      return yield* new AccountError({ code: "client" });

    if (
      grant.user_id !== state.value.userId ||
      grant.login !== state.value.login ||
      grant.expires_in <= 0
    )
      return yield* new AccountError({ code: "identity" });

    if (
      !Arr.every(state.value.scopes, (scope) => !!grant.scopes?.includes(scope))
    )
      return yield* new AccountError({ code: "scopes" });
    const completed = yield* Clock.currentTimeMillis;

    const saved = yield* store.update((account) => {
      if (
        !current(account) ||
        completed >= state.value.expiresAt ||
        account.authGeneration !== state.value.generation ||
        (account.lifecycle[state.value.userId]?.sequence ?? 0) !==
          state.value.removalSequence
      )
        return false;
      const priorLife = account.lifecycle[state.value.userId];

      if (
        priorLife?.kind === "removed" &&
        state.value.roles.includes("broadcaster")
      )
        account.lifecycle[state.value.userId] = {
          kind: "installed",
          // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The atomic state-update callback allocates a fresh secure ID synchronously for each new installation.
          id: InstallationId.make(crypto.randomUUID()),
          negative: null,
          sequence: priorLife.sequence,
          version: 0,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };

      if (
        priorLife?.kind === "installed" &&
        state.value.roles.includes("broadcaster")
      ) {
        const old = account.subscriptions[state.value.userId];

        if (old) retireId(account, old.id, completed);
        delete account.subscriptions[state.value.userId];
        account.lifecycle[state.value.userId] = {
          ...priorLife,
          negative: null,
          version: priorLife.version + 1,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };
      }

      if (
        priorLife?.kind === "removed" &&
        state.value.roles.includes("broadcaster")
      )
        account.enrollments = Arr.filter(
          account.enrollments,
          (entry) =>
            !!(
              (entry.phase.kind !== "member" && entry.phase.kind !== "left") ||
              entry.phase.broadcasterId !== state.value.userId
            ),
        );

      account.grants[state.value.userId] = [...state.value.scopes];

      return true;
    });

    if (!saved) return yield* new AccountError({ code: "state" });

    return yield* status;
  });

  const enrollmentStatus = Effect.fnUntraced(function* (
    session: typeof EnrollmentSession.Type,
  ): Effect.fn.Return<EnrollmentStatus, AccountError> {
    const valid = yield* Schema.decodeEffect(EnrollmentSession)(session).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    const now = yield* Clock.currentTimeMillis;

    return yield* store.update((state): EnrollmentStatus => {
      const entry = Arr.findFirst(
        state.enrollments,
        (entry) => !!(entry.session === valid),
      );

      if (config.identity.senderKind !== "bot")
        return { kind: "failed", reason: "unavailable" };

      if (Option.isNone(entry) || entry.value.expiresAt <= now)
        return { kind: "failed", reason: "expired" };

      if (entry.value.phase.kind === "left")
        return state.lifecycle[entry.value.phase.broadcasterId]?.kind ===
          "removed"
          ? { kind: "left", login: entry.value.phase.login }
          : { kind: "failed", reason: "expired" };

      if (
        !current(state) ||
        entry.value.revision !== config.revision ||
        (entry.value.phase.kind !== "member" &&
          entry.value.generation !== state.authGeneration)
      )
        return { kind: "failed", reason: "authorization-required" };

      return Match.value(entry.value.phase).pipe(
        Match.when(
          { kind: "failed" },
          (phase) => ({ kind: "failed", reason: phase.reason }) as const,
        ),
        Match.when({ kind: "pending" }, () => ({ kind: "pending" }) as const),
        Match.when({ kind: "exchanging" }, (phase) =>
          phase.lease.until > now
            ? ({ kind: "pending" } as const)
            : ({ kind: "failed", reason: "expired" } as const),
        ),
        Match.when({ kind: "member" }, (phase): EnrollmentStatus => {
          const id = phase.broadcasterId;

          const member = Arr.findFirst(
            desiredChannels(state, config.identity.senderKind),
            (channel) => !!(channel.id === id),
          );

          if (Option.isNone(member))
            return { kind: "failed", reason: "authorization-required" };

          if (!state.sender)
            return {
              kind: "attention-required",
              login: member.value.login,
              reason: "setup-required",
            };

          if (!granted(state, state.sender.id, senderScopes))
            return {
              kind: "attention-required",
              login: member.value.login,
              reason: "sender-authorization-required",
            };

          if (!granted(state, id, broadcasterScopes))
            return {
              kind: "attention-required",
              login: member.value.login,
              reason: "broadcaster-authorization-required",
            };

          if (!config.webhookReady)
            return {
              kind: "attention-required",
              login: member.value.login,
              reason: "ingress-required",
            };

          return Match.value(decideChannel(state, id)).pipe(
            Match.when({ kind: "ready" }, (): EnrollmentStatus => ({
              kind: "ready",
              login: member.value.login,
            })),
            Match.when(
              { kind: Match.is("pending", "repair-required") },
              (): EnrollmentStatus => ({
                kind: "recovering",
                login: member.value.login,
              }),
            ),
            Match.orElse((): EnrollmentStatus => ({
              kind: "attention-required",
              login: member.value.login,
              reason: "setup-required",
            })),
          );
        }),
        Match.exhaustive,
      );
    });
  });

  const beginEnrollment = Effect.fnUntraced(function* (input: EnrollmentBegin) {
    const valid = yield* Schema.decodeEffect(EnrollmentBegin)(input).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    if (
      config.identity.senderKind !== "bot" ||
      !config.webhookReady ||
      !Schema.is(CallbackUrl)(config.callback) ||
      !Schema.is(OAuthRedirectUrl)(config.redirect)
    )
      return yield* new AccountError({ code: "configuration" });
    const now = yield* Clock.currentTimeMillis;
    const nonce = yield* digest(valid.state);

    const result = yield* store.update((state) => {
      if (
        !current(state) ||
        !state.sender ||
        !granted(state, state.sender.id, senderScopes)
      )
        return "configuration";

      const retained = Arr.filter(
        state.enrollments,
        (entry) =>
          !!(entry.expiresAt > now && entry.session !== valid.previousSession),
      );

      if (
        Arr.filter(
          retained,
          (entry) =>
            !!(
              entry.phase.kind === "pending" ||
              entry.phase.kind === "exchanging"
            ),
        ).length >= policy.maxEnrollmentIntents
      )
        return "capacity";

      const left = Arr.filter(
        retained,
        (entry) => !!(entry.phase.kind === "left"),
      );

      const active = Arr.filter(
        retained,
        (entry) =>
          !!(entry.phase.kind !== "failed" && entry.phase.kind !== "left"),
      );

      const failureSlots =
        policy.maxChannels + policy.maxEnrollmentIntents - active.length - 1;

      const failures = Arr.filter(
        retained,
        (entry) => !!(entry.phase.kind === "failed"),
      ).slice(0, failureSlots);

      state.enrollments = [
        ...active,
        ...left,
        ...failures,
        {
          session: valid.session,
          nonce,
          revision: config.revision,
          generation: state.authGeneration,
          publicRevocationGeneration: state.publicRevocationGeneration,
          expiresAt: now + policy.oauthMs,
          phase: { kind: "pending" },
        },
      ];

      return "stored";
    });

    if (result !== "stored") return yield* new AccountError({ code: result });

    const params = new URLSearchParams({
      client_id: config.identity.twitchClientId,
      redirect_uri: config.redirect,
      response_type: "code",
      scope: Arr.join(broadcasterScopes, " "),
      state: valid.state,
      force_verify: "true",
    });

    return `https://id.twitch.tv/oauth2/authorize?${params}`;
  });

  const completeEnrollment = Effect.fnUntraced(function* (
    input: EnrollmentCompletion,
  ) {
    const valid = yield* Schema.decodeEffect(EnrollmentCompletion)(input).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    if (config.identity.senderKind !== "bot")
      return yield* new AccountError({ code: "configuration" });
    const clock = yield* Clock.Clock;
    const nonce = yield* digest(valid.state);
    const owner = yield* secureRandomUUID;

    const claimed = yield* store.update((state) => {
      const now = clock.currentTimeMillisUnsafe();

      const entry = Option.getOrUndefined(
        Arr.findFirst(
          state.enrollments,
          (entry) =>
            !!(entry.session === valid.session && entry.nonce === nonce),
        ),
      );

      if (
        !current(state) ||
        !entry ||
        entry.phase.kind !== "pending" ||
        entry.revision !== config.revision ||
        entry.generation !== state.authGeneration ||
        entry.expiresAt <= now
      )
        return null;
      state.enrollments = Arr.map(state.enrollments, (candidate) =>
        candidate === entry
          ? {
              ...candidate,
              phase:
                valid.outcome.kind === "denied"
                  ? { kind: "failed", reason: "denied" }
                  : {
                      kind: "exchanging",
                      lease: {
                        owner,
                        until: Math.min(
                          entry.expiresAt,
                          now + policy.enrollmentLeaseMs,
                        ),
                      },
                    },
            }
          : candidate,
      );

      return {
        entry,
        until: Math.min(entry.expiresAt, now + policy.enrollmentLeaseMs),
      };
    });

    if (!claimed) return yield* new AccountError({ code: "state" });

    if (valid.outcome.kind === "denied")
      return yield* enrollmentStatus(valid.session);
    const code = valid.outcome.code;

    const run = Effect.fnUntraced(function* () {
      const token = yield* provider.exchange(code);
      const grant = yield* provider.validate(token.access_token);

      if (
        grant.client_id !== config.identity.twitchClientId ||
        token.expires_in <= 0 ||
        grant.expires_in <= 0
      )
        return yield* new AccountError({ code: "client" });

      const userId = yield* Schema.decodeUnknownEffect(BroadcasterId)(
        grant.user_id,
      ).pipe(Effect.mapError(() => new AccountError({ code: "identity" })));

      const login = yield* Schema.decodeUnknownEffect(
        Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,25}$/)),
      )(grant.login).pipe(
        Effect.mapError(() => new AccountError({ code: "identity" })),
      );

      if (
        !Arr.every(
          broadcasterScopes,
          (scope) => !!grant.scopes?.includes(scope),
        )
      )
        return yield* new AccountError({ code: "scopes" });
      const users = yield* provider.users(token.access_token, [login]);

      if (
        !Arr.some(
          users,
          (user) => !!(user.id === userId && user.login === login),
        )
      )
        return yield* new AccountError({ code: "identity" });

      const result = yield* store.update((state) => {
        const completed = clock.currentTimeMillisUnsafe();

        const entry = Option.getOrUndefined(
          Arr.findFirst(
            state.enrollments,
            (entry) =>
              !!(entry.session === valid.session && entry.nonce === nonce),
          ),
        );

        if (
          !current(state) ||
          state.authGeneration !== claimed.entry.generation ||
          !entry ||
          entry.phase.kind !== "exchanging" ||
          entry.phase.lease.owner !== owner ||
          entry.phase.lease.until <= completed ||
          entry.expiresAt <= completed ||
          entry.revision !== config.revision
        )
          return "state";

        const member = Option.getOrUndefined(
          Arr.findFirst(
            state.publicMembers,
            (member) => !!(member.id === userId),
          ),
        );

        if (
          Math.max(
            member?.revocationGeneration ?? 0,
            state.lifecycle[userId]?.sequence ?? 0,
          ) > claimed.entry.publicRevocationGeneration
        )
          return "state";

        const existing = Option.getOrUndefined(
          Arr.findFirst(
            desiredChannels(state, config.identity.senderKind),
            (channel) => !!(channel.id === userId),
          ),
        );

        if (
          !existing &&
          desiredChannels(state, config.identity.senderKind).length >=
            policy.maxChannels
        ) {
          state.enrollments = Arr.map(state.enrollments, (candidate) =>
            candidate === entry
              ? { ...candidate, phase: { kind: "failed", reason: "capacity" } }
              : candidate,
          );

          return "capacity";
        }

        const configured = Option.getOrUndefined(
          Arr.findFirst(state.channels, (channel) => !!(channel.id === userId)),
        );

        if (configured && configured.login !== login) return "identity";

        if (!existing)
          state.publicMembers = [
            ...state.publicMembers,
            { id: userId, login, revocationGeneration: 0, cleanupAfter: null },
          ];
        else
          state.publicMembers = Arr.map(state.publicMembers, (member) =>
            member.id === userId
              ? { ...member, login, cleanupAfter: null }
              : member,
          );
        const previousLife = state.lifecycle[userId];
        const previousRecord = state.subscriptions[userId];

        if (previousRecord) retireId(state, previousRecord.id, completed);
        delete state.subscriptions[userId];
        state.lifecycle[userId] = {
          kind: "installed",
          negative: null,
          id:
            previousLife?.kind === "installed"
              ? previousLife.id
              : // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The atomic state-update callback allocates a fresh secure ID synchronously for each new installation.
                InstallationId.make(crypto.randomUUID()),
          sequence: previousLife?.sequence ?? 0,
          version:
            previousLife?.kind === "installed" ? previousLife.version + 1 : 0,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };
        state.grants[userId] = Arr.dedupe([
          ...(state.grants[userId] ?? []),
          ...broadcasterScopes,
        ]);
        state.enrollments = Arr.map(
          Arr.filter(
            state.enrollments,
            (candidate) =>
              !!(
                candidate === entry ||
                (candidate.phase.kind !== "member" &&
                  candidate.phase.kind !== "left") ||
                candidate.phase.broadcasterId !== userId
              ),
          ),
          (candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  expiresAt: completed + policy.enrollmentSessionMs,
                  phase: { kind: "member", broadcasterId: userId },
                }
              : candidate,
        );

        return "saved";
      });

      if (result !== "saved") return yield* new AccountError({ code: result });

      return yield* enrollmentStatus(valid.session);
    });

    return yield* run().pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, claimed.until - clock.currentTimeMillisUnsafe()),
        orElse: () => new AccountError({ code: "state" }),
      }),
      Effect.tapError(() =>
        store.update((state) => {
          state.enrollments = Arr.map(state.enrollments, (entry) =>
            entry.session === valid.session &&
            entry.nonce === nonce &&
            entry.phase.kind === "exchanging" &&
            entry.phase.lease.owner === owner
              ? {
                  ...entry,
                  phase: { kind: "failed", reason: "authorization-failed" },
                }
              : entry,
          );
        }),
      ),
    );
  });

  const repairMemberships = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (
      !(yield* store.shared(
        (state) => state.nextRecoveryAt !== null && state.nextRecoveryAt <= now,
      ))
    )
      return;

    const due = yield* store.update((state) =>
      Arr.map(
        Arr.filter(
          Rec.toEntries(state.lifecycle),
          (entry) =>
            !!(
              entry[1].kind === "installed" &&
              entry[1].recovery &&
              entry[1].recovery.due <= now
            ),
        ).sort(
          (a, b) =>
            (a[1].kind === "installed"
              ? (a[1].recovery?.due ?? Infinity)
              : Infinity) -
            (b[1].kind === "installed"
              ? (b[1].recovery?.due ?? Infinity)
              : Infinity),
        ),
        ([id]) => id,
      ),
    );

    for (const id of due) {
      const started = yield* Clock.currentTimeMillis;
      const owner = yield* secureRandomUUID;

      const claim = yield* store.update((state) => {
        const life = state.lifecycle[id];

        if (
          !current(state) ||
          life?.kind !== "installed" ||
          !life.recovery ||
          life.recovery.due > started
        )
          return null;

        if (state.setupLease && state.setupLease.until > started) {
          state.lifecycle[id] = {
            ...life,
            recovery: { ...life.recovery, due: state.setupLease.until + 1 },
          };

          return null;
        }

        const base =
          policy.recoveryMs[Math.min(life.recovery.stage, 2)] ?? 900_000;

        const jitter =
          0.9 +
          ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4294967295) *
            0.2;

        const sender =
          state.apiBlockedUntil <= started &&
          state.sender &&
          granted(state, state.sender.id, senderScopes) &&
          granted(state, id, broadcasterScopes) &&
          config.webhookReady
            ? state.sender.id
            : null;

        state.lifecycle[id] = {
          ...life,
          recovery: {
            due: Math.max(
              started + Math.round(base * jitter),
              state.apiBlockedUntil,
            ),
            stage:
              sender === null
                ? life.recovery.stage
                : Math.min(2, life.recovery.stage + 1),
          },
        };

        if (sender === null) return null;
        state.setupLease = {
          owner,
          until: started + policy.setupLeaseMs,
          revision: config.revision,
          generation: state.authGeneration,
        };

        return {
          generation: state.authGeneration,
          sender,
          installation: life.id,
        };
      });

      if (!claim) continue;
      yield* Effect.gen(function* () {
        const session = yield* appToken();
        yield* reconcile(
          owner,
          session.token,
          claim.sender,
          [id],
          claim.generation,
        ).pipe(
          Effect.tapError((error) =>
            error.code === "client"
              ? invalidate(session.generation)
              : Effect.void,
          ),
        );
      }).pipe(
        Effect.catch((error) =>
          store.update((state) => {
            if (error.retryAt)
              state.apiBlockedUntil = Math.max(
                state.apiBlockedUntil,
                error.retryAt,
              );
          }),
        ),
        Effect.ensuring(
          store.update((state) => {
            if (state.setupLease?.owner === owner) state.setupLease = null;
            const life = state.lifecycle[id];

            if (life?.kind !== "installed" || life.id !== claim.installation)
              return;

            if (decideChannel(state, id).kind === "ready")
              state.lifecycle[id] = { ...life, recovery: null };
            else if (life.recovery && state.apiBlockedUntil > life.recovery.due)
              state.lifecycle[id] = {
                ...life,
                recovery: { ...life.recovery, due: state.apiBlockedUntil },
              };
          }),
        ),
      );
    }
  });

  const leaveEnrollment = Effect.fnUntraced(function* (
    session: typeof EnrollmentSession.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const clock = yield* Clock.Clock;

    const id = yield* store.update((state) =>
      Arr.findFirst(
        state.enrollments,
        (entry) => entry.session === session && entry.expiresAt > now,
      ).pipe(
        Option.flatMap((entry) =>
          entry.phase.kind === "member" || entry.phase.kind === "left"
            ? Option.some(entry.phase.broadcasterId)
            : Option.none(),
        ),
      ),
    );

    if (Option.isNone(id)) return yield* new AccountError({ code: "state" });

    const result = yield* gated(
      id.value,
      store.update((state) => {
        const entry = Arr.findFirst(
          state.enrollments,
          (entry) =>
            entry.session === session &&
            entry.expiresAt > clock.currentTimeMillisUnsafe(),
        );

        if (Option.isNone(entry)) return Option.none();

        if (entry.value.phase.kind === "left")
          return state.lifecycle[entry.value.phase.broadcasterId]?.kind ===
            "removed"
            ? Option.some({
                kind: "left",
                login: entry.value.phase.login,
              } as const)
            : Option.none();

        if (!current(state) || entry.value.revision !== config.revision)
          return Option.none();

        if (entry.value.phase.kind !== "member") return Option.none();

        const member = Arr.findFirst(
          desiredChannels(state, config.identity.senderKind),
          (member) => member.id === id.value,
        );

        if (Option.isNone(member)) return Option.none();
        const login = member.value.login;
        removeChannel(state, id.value, clock.currentTimeMillisUnsafe());
        state.enrollments = Arr.map(state.enrollments, (candidate) =>
          candidate.session === session
            ? {
                ...candidate,
                phase: { kind: "left", broadcasterId: id.value, login },
              }
            : candidate,
        );

        return Option.some({ kind: "left", login } as const);
      }),
    );

    if (Option.isNone(result))
      return yield* new AccountError({ code: "state" });

    return result.value;
  });

  const observeSubscription = Effect.fn("TwitchAccount.subscription")(
    function* (input: SubscriptionObservation) {
      const valid = yield* Schema.decodeEffect(SubscriptionObservation)(
        input,
      ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

      const clock = yield* Clock.Clock;

      return yield* gated(
        valid.broadcasterId,
        store.update((state): ChatSource | null => {
          const now = clock.currentTimeMillisUnsafe();

          if (!current(state)) return null;

          if (
            valid.binding !== config.subscriptionBinding ||
            valid.callback !== config.callback ||
            state.sender?.id !== valid.senderId ||
            !Arr.some(
              desiredChannels(state, config.identity.senderKind),
              (channel) => !!(channel.id === valid.broadcasterId),
            )
          )
            return null;
          const authority = state.lifecycle[valid.broadcasterId];

          const retained =
            authority?.kind === "installed" ? authority.negative : null;

          if (isAuthorizationLoss(valid.status) && retained?.id === valid.id) {
            removeChannel(state, valid.broadcasterId, now);

            return null;
          }

          const record = state.subscriptions[valid.broadcasterId];

          const confirmed =
            record?.id === valid.id && matchesTarget(state, record);

          const retired = state.revoked[valid.id];

          if (
            record &&
            record.id !== valid.id &&
            (!retired || retired.until <= now)
          )
            return null;

          if (liveSubscription(valid.status)) {
            if (
              !state.revoked[valid.id] &&
              confirmed &&
              liveSubscription(record.status)
            )
              state.subscriptions[valid.broadcasterId] = {
                ...record,
                status: record.status === "enabled" ? "enabled" : valid.status,
              };

            const life = state.lifecycle[valid.broadcasterId];

            if (
              confirmed &&
              decideChannel(state, valid.broadcasterId).kind === "ready" &&
              life?.kind === "installed"
            ) {
              state.lifecycle[valid.broadcasterId] = {
                ...life,
                recovery: null,
              };

              return { installationId: life.id, subscriptionId: valid.id };
            }

            return null;
          }

          if (confirmed) revokeSubscription(state, valid, now);

          return null;
        }),
      );
    },
  );

  const dispatch = Effect.fn("TwitchAccount.dispatch")(function* (
    input: Dispatch,
  ): Effect.fn.Return<DispatchOutcome, AccountError> {
    const valid = yield* Schema.decodeEffect(Dispatch)(input).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    const fingerprint = yield* digest(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        valid,
      ).pipe(Effect.orDie),
    );

    const first = yield* Clock.currentTimeMillis;

    const read = yield* store.sendAttempt((state) => {
      reclaimSend(state, first);
      const previous = state.attempts[valid.attemptId];

      if (previous?.kind === "sending" && !previous.source) {
        state.attempts[valid.attemptId] = {
          ...previous,
          kind: "terminal",
          outcome: { kind: "ambiguous" },
          privateCode: "interrupted",
        };

        return Option.some<DispatchOutcome>({ kind: "ambiguous" });
      }

      if (previous && previous.fingerprint !== fingerprint)
        return Option.some<DispatchOutcome>({ kind: "rejected" });

      const recorded = Match.value(previous).pipe(
        Match.when(Predicate.isUndefined, () => Option.none<DispatchOutcome>()),
        Match.discriminatorsExhaustive("kind")({
          terminal: (previous) => Option.some(previous.outcome),
          sending: (previous): Option.Option<DispatchOutcome> => {
            if (previous.instance !== instance || first >= previous.deadline)
              state.attempts[valid.attemptId] = {
                ...previous,
                kind: "terminal",
                outcome: { kind: "ambiguous" },
                privateCode: "interrupted",
              };

            return Option.some({ kind: "ambiguous" });
          },
          waiting: () => Option.none<DispatchOutcome>(),
        }),
      );

      if (Option.isSome(recorded)) return recorded;

      if (first >= valid.deadline)
        return Option.some<DispatchOutcome>({ kind: "expired" });

      if (!current(state))
        return Option.some<DispatchOutcome>({ kind: "rejected" });

      return Option.none<DispatchOutcome>();
    });

    if (Option.isSome(read)) return read.value;

    const usable = yield* store.channelDispatch(
      valid.broadcasterId,
      (state) => {
        for (const [id, entry] of Rec.toEntries(state.revoked))
          if (entry.until <= first && entry.deleteDue === null)
            delete state.revoked[id];
        const life = state.lifecycle[valid.broadcasterId];

        return (
          life?.kind === "installed" &&
          life.id === valid.source.installationId &&
          state.subscriptions[valid.broadcasterId]?.id ===
            valid.source.subscriptionId &&
          decideChannel(state, valid.broadcasterId).kind === "ready"
        );
      },
    );

    if (!usable)
      return yield* store.sendAttempt((state): DispatchOutcome => {
        const prior = state.attempts[valid.attemptId];

        if (prior?.kind === "sending") return { kind: "ambiguous" };

        if (prior?.kind === "terminal") return prior.outcome;
        state.attempts[valid.attemptId] = {
          kind: "terminal",
          channel: valid.broadcasterId,
          source: valid.source,
          fingerprint,
          deadline: valid.deadline,
          retainUntil: valid.deadline + policy.retentionMs,
          outcome: { kind: "rejected" },
          privateCode: "unavailable",
        };

        return { kind: "rejected" };
      });

    const session = yield* appToken().pipe(Effect.orElseSucceed(() => null));

    if (!session) {
      const now = yield* Clock.currentTimeMillis;

      return now + 1_000 < valid.deadline
        ? { kind: "retryable", retryAt: Deadline.make(now + 1_000) }
        : { kind: "expired" };
    }

    return yield* gated(
      valid.broadcasterId,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const owner = yield* secureRandomUUID;

        const claimed = yield* store.channelDispatch(
          valid.broadcasterId,
          (state) => {
            reclaimSend(state, now);

            for (const [key, tombstone] of Rec.toEntries(state.revoked))
              if (tombstone.until <= now && tombstone.deleteDue === null)
                delete state.revoked[key];
            const prior = state.attempts[valid.attemptId];

            if (prior && prior.fingerprint !== fingerprint)
              return {
                kind: "outcome",
                outcome: { kind: "rejected" },
              } as const;

            const recorded = Match.value(prior).pipe(
              Match.when(Predicate.isUndefined, () =>
                Option.none<DispatchOutcome>(),
              ),
              Match.discriminatorsExhaustive("kind")({
                terminal: (prior) => Option.some(prior.outcome),
                sending: () =>
                  Option.some<DispatchOutcome>({ kind: "ambiguous" }),
                waiting: () => Option.none<DispatchOutcome>(),
              }),
            );

            if (Option.isSome(recorded))
              return { kind: "outcome", outcome: recorded.value } as const;

            if (now >= valid.deadline)
              return { kind: "outcome", outcome: { kind: "expired" } } as const;
            const retainUntil = valid.deadline + policy.retentionMs;

            if (
              !prior &&
              Rec.keys(state.attempts).length >= policy.maxAttempts
            ) {
              const availableAt = Math.min(
                ...Arr.map(
                  Rec.values(state.attempts),
                  (attempt) => attempt.retainUntil,
                ),
              );

              if (availableAt < valid.deadline)
                return {
                  kind: "outcome",
                  outcome: {
                    kind: "retryable",
                    retryAt: Deadline.make(availableAt),
                  },
                } as const;

              return { kind: "outcome", outcome: { kind: "expired" } } as const;
            }

            const channel = Arr.findFirst(
              desiredChannels(state, config.identity.senderKind),
              (channel) => !!(channel.id === valid.broadcasterId),
            );

            const sender = state.sender;
            const life = state.lifecycle[valid.broadcasterId];

            if (
              life?.kind !== "installed" ||
              life.id !== valid.source.installationId ||
              state.subscriptions[valid.broadcasterId]?.id !==
                valid.source.subscriptionId ||
              Option.isNone(channel) ||
              !sender ||
              decideChannel(state, channel.value.id).kind !== "ready"
            ) {
              state.attempts[valid.attemptId] = {
                kind: "terminal",
                channel: valid.broadcasterId,
                source: valid.source,
                fingerprint,
                deadline: valid.deadline,
                retainUntil,
                outcome: { kind: "rejected" },
                privateCode: "unavailable",
              };

              return {
                kind: "outcome",
                outcome: { kind: "rejected" },
              } as const;
            }

            if (state.session?.generation !== session.generation) {
              const retryAt = now + 100;

              return {
                kind: "outcome",
                outcome: (retryAt < valid.deadline
                  ? { kind: "retryable", retryAt: Deadline.make(retryAt) }
                  : { kind: "expired" }) satisfies DispatchOutcome,
              } as const;
            }

            const retryAt = reserveAt(state, channel.value.id, now);

            if (retryAt > now) {
              if (retryAt >= valid.deadline) {
                state.attempts[valid.attemptId] = {
                  kind: "terminal",
                  channel: valid.broadcasterId,
                  source: valid.source,
                  fingerprint,
                  deadline: valid.deadline,
                  retainUntil,
                  outcome: { kind: "expired" },
                  privateCode: "rate-deadline",
                };

                return {
                  kind: "outcome",
                  outcome: { kind: "expired" },
                } as const;
              }

              state.attempts[valid.attemptId] = {
                kind: "waiting",
                channel: valid.broadcasterId,
                source: valid.source,
                fingerprint,
                deadline: valid.deadline,
                retainUntil,
                retryAt,
              };

              return {
                kind: "outcome",
                outcome: { kind: "retryable", retryAt: Deadline.make(retryAt) },
              } as const;
            }

            state.reservations = [
              ...state.reservations,
              { channel: channel.value.id, at: now },
            ];
            state.attempts[valid.attemptId] = {
              kind: "sending",
              channel: valid.broadcasterId,
              source: valid.source,
              fingerprint,
              deadline: valid.deadline,
              retainUntil,
              owner,
              instance,
            };

            return { kind: "send", sender: sender.id } as const;
          },
        );

        if (claimed.kind === "outcome") return claimed.outcome;

        const result = yield* provider.send(
          session.token,
          claimed.sender,
          valid,
        );

        const completed = yield* Clock.currentTimeMillis;

        const outcome = yield* store.sendAttempt((state): DispatchOutcome => {
          if (result.kind === "unauthorized")
            invalidateSession(state, session.generation);

          const prior = state.attempts[valid.attemptId];

          if (prior?.kind !== "sending" || prior.owner !== owner)
            return { kind: "ambiguous" };

          if (Predicate.isNotUndefined(result.blockedUntil))
            state.apiBlockedUntil = Math.max(
              state.apiBlockedUntil,
              result.blockedUntil,
            );

          const outcome = Match.value(result).pipe(
            Match.whenOr(
              { kind: "limited" },
              { kind: "unauthorized" },
              (result): DispatchOutcome => {
                const retryAt =
                  result.kind === "limited" ? result.retryAt : completed + 100;

                if (result.kind === "limited")
                  state.apiBlockedUntil = Math.max(
                    state.apiBlockedUntil,
                    retryAt,
                  );

                if (retryAt < valid.deadline) {
                  state.attempts[valid.attemptId] = {
                    kind: "waiting",
                    channel: valid.broadcasterId,
                    source: valid.source,
                    fingerprint,
                    deadline: valid.deadline,
                    retainUntil: prior.retainUntil,
                    retryAt,
                  };

                  return { kind: "retryable", retryAt: Deadline.make(retryAt) };
                }

                return { kind: "expired" };
              },
            ),
            Match.discriminatorsExhaustive("kind")({
              sent: (result): DispatchOutcome => ({
                kind: "sent",
                messageId: result.messageId,
              }),
              rejected: (): DispatchOutcome => ({ kind: "rejected" }),
              ambiguous: (): DispatchOutcome => ({ kind: "ambiguous" }),
              expired: (): DispatchOutcome => ({ kind: "expired" }),
            }),
          );

          if (outcome.kind === "retryable") return outcome;
          state.attempts[valid.attemptId] = {
            kind: "terminal",
            channel: valid.broadcasterId,
            source: valid.source,
            fingerprint,
            deadline: valid.deadline,
            retainUntil: prior.retainUntil,
            outcome,
            privateCode: result.kind === "rejected" ? result.code : null,
          };

          return outcome;
        });

        yield* Effect.logInfo("Twitch dispatch complete").pipe(
          Effect.annotateLogs({ outcome: outcome.kind }),
        );

        return outcome;
      }),
    );
  });

  const credentialAlarm = Effect.fnUntraced(function* () {
    const maintained = yield* store.shared((state) => {
      if (!current(state)) return false;

      const active =
        (Predicate.isNotNull(state.session) ||
          Predicate.isNotNull(state.tokenLease) ||
          state.credentialFailures > 0) &&
        state.credentialFailures < 3;

      if (!active) state.nextCredentialCheck = null;

      return active;
    });

    if (maintained)
      yield* appToken().pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* store.shared((state) => {
              if (current(state))
                state.nextCredentialCheck =
                  state.credentialFailures < 3
                    ? Math.max(
                        now + 1,
                        state.tokenLease?.until ??
                          state.nextCredentialCheck ??
                          now + 60_000,
                        state.tokenRetryAt,
                      )
                    : null;
            });
          }),
        ),
        Effect.asVoid,
      );
  });

  const alarm = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const due = yield* store.shared(
      (state) => state.nextCleanupAt !== null && state.nextCleanupAt <= now,
    );

    if (due) yield* store.update((state) => reclaim(state, now));
    yield* credentialAlarm();
    yield* repairMemberships();
    yield* cleanupRemote();
  });

  return {
    enrollment: TwitchEnrollment.of({
      leave: leaveEnrollment,
      begin: beginEnrollment,
      complete: completeEnrollment,
      status: enrollmentStatus,
    }),
    service: TwitchAccount.of({
      dispatch,
      setup,
      status,
      completeOAuth,
      observeSubscription,
    }),
    credentialAlarm: alarm,
  };
});

export const accountLayer = (config: AccountConfig) =>
  Layer.effect(
    TwitchAccount,
    makeAccount(config).pipe(Effect.map((account) => account.service)),
  );

export class AccountService extends Context.Service<
  AccountService,
  Effect.Success<ReturnType<typeof makeAccount>>
>()("@arctools/AccountService") {}

export const accountServiceLayer = (config: AccountConfig) =>
  Layer.effect(AccountService, makeAccount(config));
