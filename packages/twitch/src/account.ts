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
) => scopes.every((scope) => state.grants[id]?.includes(scope));

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
    Object.entries(state.lifecycle).map(([id, life]) => [
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
      entry.lock.withPermit,
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
    [...new Set(ids)]
      .sort()
      .reduceRight((next, id) => gated(id, next), operation);

  const instance = crypto.randomUUID();
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
    desiredChannels(state, config.identity.senderKind).some(
      (channel) => channel.id === record.broadcasterId,
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
      !desiredChannels(state, config.identity.senderKind).some(
        (channel) => channel.id === id,
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

    const login =
      desiredChannels(state, config.identity.senderKind).find(
        (member) => member.id === id,
      )?.login ??
      state.publicMembers.find((member) => member.id === id)?.login ??
      state.channels.find((member) => member.id === id)?.login ??
      "channel";

    state.channels = state.channels.filter((member) => member.id !== id);
    state.publicMembers = state.publicMembers.filter(
      (member) => member.id !== id,
    );

    const scopes = (state.grants[id] ?? []).filter(
      (scope) => scope !== "channel:bot",
    );

    if (scopes.length) state.grants[id] = scopes;
    else delete state.grants[id];

    for (const [key, attempt] of Object.entries(state.attempts))
      if (attempt.channel === id && attempt.kind === "waiting")
        state.attempts[key] = {
          ...attempt,
          kind: "terminal",
          outcome: { kind: "rejected" },
          privateCode: "removed",
        };
    state.oauth = state.oauth.filter((entry) => entry.userId !== id);
    state.setupLease = null;
    state.enrollments = state.enrollments.map((entry) =>
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
      const login =
        desiredChannels(state, config.identity.senderKind).find(
          (member) => member.id === observation.broadcasterId,
        )?.login ?? "channel";

      removeChannel(state, observation.broadcasterId, now);
      state.enrollments = state.enrollments.map((entry) =>
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
        state.enrollments = state.enrollments.map((entry) =>
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

      for (const record of Object.values(state.subscriptions))
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
      const owner = crypto.randomUUID();

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
                token = (yield* provider.mint()).access_token;

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
    (effect) => effect.pipe(tokenLock.withPermit),
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

  const status = Effect.fn("TwitchAccount.status")(
    function* (): Effect.fn.Return<AccountStatus, AccountError> {
      const now = yield* Clock.currentTimeMillis;

      const result = yield* store.update((state) => {
        reclaim(state, now);

        const decisions = desiredChannels(
          state,
          config.identity.senderKind,
        ).map((channel) => decideChannel(state, channel.id));

        const channels = desiredChannels(state, config.identity.senderKind).map(
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
          : ((
              [
                "unresolved",
                "repair-required",
                "authorization-required",
                "ingress-required",
                "pending",
              ] satisfies AccountStatus["setup"][]
            ).find((kind) =>
              decisions.some((decision) => decision.kind === kind),
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
          attempts: Object.keys(state.attempts).length,
          credentialCheckAt: state.session?.validatedAt ?? null,
        } satisfies AccountStatus;
      });

      if (result.revision !== config.revision)
        return yield* new AccountError({ code: "stale" });

      return result;
    },
  );

  const deleteObligation = Effect.fnUntraced(function* (
    token: string,
    id: string,
  ) {
    const now = yield* Clock.currentTimeMillis;

    const owner = crypto.randomUUID();

    const claim = yield* store.update((state) => {
      const entry = state.revoked[id];

      if (
        !entry ||
        entry.deleteDue === null ||
        state.apiBlockedUntil > now ||
        Object.values(state.subscriptions).some(
          (record) =>
            record.id === id &&
            liveSubscription(record.status) &&
            matchesTarget(state, record),
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

    const sweepOwner = crypto.randomUUID();

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
        ids: Object.entries(state.revoked)
          .filter(
            ([, entry]) => entry.deleteDue !== null && entry.deleteDue <= now,
          )
          .sort((a, b) => (a[1].deleteDue ?? 0) - (b[1].deleteDue ?? 0))
          .slice(0, 4)
          .map(([id]) => id),
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
                Object.values(state.subscriptions).some(
                  (local) =>
                    local.id === record.id &&
                    liveSubscription(local.status) &&
                    matchesTarget(state, local),
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
          Object.values(state.subscriptions).find((record) => record.id === id)
            ?.broadcasterId ??
          remote.find((record) => record.id === id)?.condition
            .broadcaster_user_id ??
          id,
      );

      const retired = yield* gated(
        broadcaster,
        store.update((state) => {
          const now = clock.currentTimeMillisUnsafe();

          if (!ownsSetup(state, owner, generation, now)) return false;
          retireId(state, id, now);

          for (const [channel, record] of Object.entries(state.subscriptions))
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
      channels: Object.keys(state.lifecycle),
    }));

    const versions = snapshot.versions;
    const remote = yield* provider.list(token);
    const clock = yield* Clock.Clock;

    const cleanup = yield* gatedChannels(
      [
        ...snapshot.channels,
        ...remote.flatMap((record) =>
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
          return null;
        const ids = new Set<string>();

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
            Object.values(state.subscriptions).some((local) =>
              sameRemote(local, subscription),
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
          } else ids.add(subscription.id);
        }

        for (const record of Object.values(state.subscriptions)) {
          if (
            !matchesTarget(state, record) ||
            !liveSubscription(record.status) ||
            state.revoked[record.id] ||
            !remote.some((subscription) => sameRemote(record, subscription))
          )
            ids.add(record.id);
        }

        return [...ids];
      }),
    );

    if (Predicate.isNull(cleanup))
      return yield* new AccountError({ code: "stale" });

    for (const id of cleanup) yield* retire(id);

    for (const channel of channels) {
      const now = yield* Clock.currentTimeMillis;

      const action = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, now)) return "stale";

        if (
          !state.sender ||
          !granted(state, state.sender.id, senderScopes) ||
          !granted(state, channel, broadcasterScopes) ||
          !desiredChannels(state, config.identity.senderKind).some(
            (entry) => entry.id === channel,
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
              !desiredChannels(state, config.identity.senderKind).some(
                (entry) => entry.id === channel,
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
    const owner = crypto.randomUUID();

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

      const logins = [
        ...new Set([
          config.identity.senderLogin,
          ...config.identity.channelLogins,
        ]),
      ];

      const users = yield* authenticated(provider.users(session.token, logins));

      const sender = users.find(
        (user) => user.login === config.identity.senderLogin,
      );

      const channels = config.identity.channelLogins.map((login) =>
        users.find((user) => user.login === login),
      );

      if (!sender || channels.some((channel) => !channel))
        return yield* new AccountError({ code: "identity" });

      const resolved = yield* Effect.forEach(channels, (channel) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({ login: Schema.String, id: BroadcasterId }),
        )(channel).pipe(
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
        state.channels = resolved.filter(
          (channel) => state.lifecycle[channel.id]?.kind !== "removed",
        );

        for (const channel of resolved)
          if (!state.lifecycle[channel.id])
            state.lifecycle[channel.id] = {
              kind: "installed",
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

        if (resolved.some((channel) => channel.id === user.id)) {
          roles.push("broadcaster");
          scopes.push(...broadcasterScopes);
        }

        if (roles.length === 0) continue;

        const needed = yield* store.update(
          (state) => !granted(state, user.id, scopes),
        );

        if (!needed) continue;
        const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`;
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
          scope: scopes.join(" "),
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

        state.oauth = state.oauth.filter(
          (entry) => !granted(state, entry.userId, entry.scopes),
        );

        const retained =
          state.oauth.length + states.length <= policy.maxOAuth
            ? state.oauth
            : state.oauth.filter(
                (entry) =>
                  entry.operator === operator &&
                  entry.revision === config.revision &&
                  entry.generation === generation &&
                  !granted(state, entry.userId, entry.scopes) &&
                  !states.some((next) => next.userId === entry.userId),
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
              desiredChannels(state, config.identity.senderKind)
                .filter((channel) => {
                  const decision = decideChannel(state, channel.id);

                  return (
                    decision.kind === "pending" ||
                    decision.kind === "ready" ||
                    (decision.kind === "repair-required" &&
                      granted(state, channel.id, broadcasterScopes))
                  );
                })
                .map((channel) => channel.id),
            ),
            generation,
          ),
        );
      }

      return { status: yield* status(), authorizations };
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
    const valid = yield* Schema.decodeUnknownEffect(OAuthCompletion)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    const now = yield* Clock.currentTimeMillis;
    const hash = yield* digest(valid.state);

    const state = yield* store.update((account) => {
      const found = account.oauth.find((entry) => entry.digest === hash);
      account.oauth = account.oauth.filter(
        (entry) => entry.digest !== hash && entry.expiresAt > now,
      );

      return found;
    });

    if (
      !state ||
      state.expiresAt <= now ||
      state.operator !== valid.operator ||
      state.revision !== config.revision
    )
      return yield* new AccountError({ code: "state" });
    const token = yield* provider.exchange(valid.code);
    const grant = yield* provider.validate(token.access_token);

    if (grant.client_id !== config.identity.twitchClientId)
      return yield* new AccountError({ code: "client" });

    if (
      grant.user_id !== state.userId ||
      grant.login !== state.login ||
      grant.expires_in <= 0
    )
      return yield* new AccountError({ code: "identity" });

    if (!state.scopes.every((scope) => grant.scopes?.includes(scope)))
      return yield* new AccountError({ code: "scopes" });
    const completed = yield* Clock.currentTimeMillis;

    const saved = yield* store.update((account) => {
      if (
        !current(account) ||
        completed >= state.expiresAt ||
        account.authGeneration !== state.generation ||
        (account.lifecycle[state.userId]?.sequence ?? 0) !==
          state.removalSequence
      )
        return false;
      const priorLife = account.lifecycle[state.userId];

      if (priorLife?.kind === "removed" && state.roles.includes("broadcaster"))
        account.lifecycle[state.userId] = {
          kind: "installed",
          id: InstallationId.make(crypto.randomUUID()),
          negative: null,
          sequence: priorLife.sequence,
          version: 0,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };

      if (
        priorLife?.kind === "installed" &&
        state.roles.includes("broadcaster")
      ) {
        const old = account.subscriptions[state.userId];

        if (old) retireId(account, old.id, completed);
        delete account.subscriptions[state.userId];
        account.lifecycle[state.userId] = {
          ...priorLife,
          negative: null,
          version: priorLife.version + 1,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };
      }

      if (priorLife?.kind === "removed" && state.roles.includes("broadcaster"))
        account.enrollments = account.enrollments.filter(
          (entry) =>
            (entry.phase.kind !== "member" && entry.phase.kind !== "left") ||
            entry.phase.broadcasterId !== state.userId,
        );

      account.grants[state.userId] = [...state.scopes];

      return true;
    });

    if (!saved) return yield* new AccountError({ code: "state" });

    return yield* status();
  });

  const enrollmentStatus = Effect.fnUntraced(function* (
    session: typeof EnrollmentSession.Type,
  ): Effect.fn.Return<EnrollmentStatus, AccountError> {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentSession)(
      session,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    const now = yield* Clock.currentTimeMillis;

    return yield* store.update((state): EnrollmentStatus => {
      const entry = state.enrollments.find((entry) => entry.session === valid);

      if (config.identity.senderKind !== "bot")
        return { kind: "failed", reason: "unavailable" };

      if (!entry || entry.expiresAt <= now)
        return { kind: "failed", reason: "expired" };

      if (entry.phase.kind === "left")
        return state.lifecycle[entry.phase.broadcasterId]?.kind === "removed"
          ? { kind: "left", login: entry.phase.login }
          : { kind: "failed", reason: "expired" };

      if (
        !current(state) ||
        entry.revision !== config.revision ||
        (entry.phase.kind !== "member" &&
          entry.generation !== state.authGeneration)
      )
        return { kind: "failed", reason: "authorization-required" };

      switch (entry.phase.kind) {
        case "failed":
          return { kind: "failed", reason: entry.phase.reason };
        case "pending":
          return { kind: "pending" };
        case "exchanging":
          return entry.phase.lease.until > now
            ? { kind: "pending" }
            : { kind: "failed", reason: "expired" };
        case "member": {
          const id = entry.phase.broadcasterId;

          const member = desiredChannels(
            state,
            config.identity.senderKind,
          ).find((channel) => channel.id === id);

          if (!member)
            return { kind: "failed", reason: "authorization-required" };

          if (!state.sender)
            return {
              kind: "attention-required",
              login: member.login,
              reason: "setup-required",
            };

          if (!granted(state, state.sender.id, senderScopes))
            return {
              kind: "attention-required",
              login: member.login,
              reason: "sender-authorization-required",
            };

          if (!granted(state, id, broadcasterScopes))
            return {
              kind: "attention-required",
              login: member.login,
              reason: "broadcaster-authorization-required",
            };

          if (!config.webhookReady)
            return {
              kind: "attention-required",
              login: member.login,
              reason: "ingress-required",
            };

          const decision = decideChannel(state, id);

          if (decision.kind === "ready")
            return { kind: "ready", login: member.login };

          if (
            decision.kind === "pending" ||
            decision.kind === "repair-required"
          )
            return { kind: "recovering", login: member.login };

          return {
            kind: "attention-required",
            login: member.login,
            reason: "setup-required",
          };
        }
      }
    });
  });

  const beginEnrollment = Effect.fnUntraced(function* (input: EnrollmentBegin) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentBegin)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

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

      const retained = state.enrollments.filter(
        (entry) =>
          entry.expiresAt > now && entry.session !== valid.previousSession,
      );

      if (
        retained.filter(
          (entry) =>
            entry.phase.kind === "pending" || entry.phase.kind === "exchanging",
        ).length >= policy.maxEnrollmentIntents
      )
        return "capacity";
      const left = retained.filter((entry) => entry.phase.kind === "left");

      const active = retained.filter(
        (entry) => entry.phase.kind !== "failed" && entry.phase.kind !== "left",
      );

      const failureSlots =
        policy.maxChannels + policy.maxEnrollmentIntents - active.length - 1;

      const failures = retained
        .filter((entry) => entry.phase.kind === "failed")
        .slice(0, failureSlots);

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
      scope: broadcasterScopes.join(" "),
      state: valid.state,
      force_verify: "true",
    });

    return `https://id.twitch.tv/oauth2/authorize?${params}`;
  });

  const completeEnrollment = Effect.fnUntraced(function* (
    input: EnrollmentCompletion,
  ) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentCompletion)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    if (config.identity.senderKind !== "bot")
      return yield* new AccountError({ code: "configuration" });
    const clock = yield* Clock.Clock;
    const nonce = yield* digest(valid.state);
    const owner = crypto.randomUUID();

    const claimed = yield* store.update((state) => {
      const now = clock.currentTimeMillisUnsafe();

      const entry = state.enrollments.find(
        (entry) => entry.session === valid.session && entry.nonce === nonce,
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
      state.enrollments = state.enrollments.map((candidate) =>
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

      if (!broadcasterScopes.every((scope) => grant.scopes?.includes(scope)))
        return yield* new AccountError({ code: "scopes" });
      const users = yield* provider.users(token.access_token, [login]);

      if (!users.some((user) => user.id === userId && user.login === login))
        return yield* new AccountError({ code: "identity" });

      const result = yield* store.update((state) => {
        const completed = clock.currentTimeMillisUnsafe();

        const entry = state.enrollments.find(
          (entry) => entry.session === valid.session && entry.nonce === nonce,
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

        const member = state.publicMembers.find(
          (member) => member.id === userId,
        );

        if (
          Math.max(
            member?.revocationGeneration ?? 0,
            state.lifecycle[userId]?.sequence ?? 0,
          ) > claimed.entry.publicRevocationGeneration
        )
          return "state";

        const existing = desiredChannels(
          state,
          config.identity.senderKind,
        ).find((channel) => channel.id === userId);

        if (
          !existing &&
          desiredChannels(state, config.identity.senderKind).length >=
            policy.maxChannels
        ) {
          state.enrollments = state.enrollments.map((candidate) =>
            candidate === entry
              ? { ...candidate, phase: { kind: "failed", reason: "capacity" } }
              : candidate,
          );

          return "capacity";
        }

        const configured = state.channels.find(
          (channel) => channel.id === userId,
        );

        if (configured && configured.login !== login) return "identity";

        if (!existing)
          state.publicMembers = [
            ...state.publicMembers,
            { id: userId, login, revocationGeneration: 0, cleanupAfter: null },
          ];
        else
          state.publicMembers = state.publicMembers.map((member) =>
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
              : InstallationId.make(crypto.randomUUID()),
          sequence: previousLife?.sequence ?? 0,
          version:
            previousLife?.kind === "installed" ? previousLife.version + 1 : 0,
          create: null,
          recovery: { due: completed + 1, stage: 0 },
        };
        state.grants[userId] = [
          ...new Set([...(state.grants[userId] ?? []), ...broadcasterScopes]),
        ];
        state.enrollments = state.enrollments
          .filter(
            (candidate) =>
              candidate === entry ||
              (candidate.phase.kind !== "member" &&
                candidate.phase.kind !== "left") ||
              candidate.phase.broadcasterId !== userId,
          )
          .map((candidate) =>
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
          state.enrollments = state.enrollments.map((entry) =>
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
      Object.entries(state.lifecycle)
        .filter(
          (entry) =>
            entry[1].kind === "installed" &&
            entry[1].recovery &&
            entry[1].recovery.due <= now,
        )
        .sort(
          (a, b) =>
            (a[1].kind === "installed"
              ? (a[1].recovery?.due ?? Infinity)
              : Infinity) -
            (b[1].kind === "installed"
              ? (b[1].recovery?.due ?? Infinity)
              : Infinity),
        )
        .map(([id]) => id),
    );

    for (const id of due) {
      const started = yield* Clock.currentTimeMillis;
      const owner = crypto.randomUUID();

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

    const id = yield* store.update((state) => {
      const entry = state.enrollments.find(
        (entry) => entry.session === session && entry.expiresAt > now,
      );

      return entry &&
        (entry.phase.kind === "member" || entry.phase.kind === "left")
        ? entry.phase.broadcasterId
        : null;
    });

    if (!id) return yield* new AccountError({ code: "state" });

    const result = yield* gated(
      id,
      store.update((state) => {
        const entry = state.enrollments.find(
          (entry) =>
            entry.session === session &&
            entry.expiresAt > clock.currentTimeMillisUnsafe(),
        );

        if (!entry) return null;

        if (entry.phase.kind === "left")
          return state.lifecycle[entry.phase.broadcasterId]?.kind === "removed"
            ? ({ kind: "left", login: entry.phase.login } as const)
            : null;

        if (!current(state) || entry.revision !== config.revision) return null;

        if (entry.phase.kind !== "member") return null;

        const member = desiredChannels(state, config.identity.senderKind).find(
          (member) => member.id === id,
        );

        if (!member) return null;
        const login = member.login;
        removeChannel(state, id, clock.currentTimeMillisUnsafe());
        state.enrollments = state.enrollments.map((candidate) =>
          candidate.session === session
            ? {
                ...candidate,
                phase: { kind: "left", broadcasterId: id, login },
              }
            : candidate,
        );

        return { kind: "left", login } as const;
      }),
    );

    if (!result) return yield* new AccountError({ code: "state" });

    return result;
  });

  const observeSubscription = Effect.fn("TwitchAccount.subscription")(
    function* (input: SubscriptionObservation) {
      const valid = yield* Schema.decodeUnknownEffect(SubscriptionObservation)(
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
            !desiredChannels(state, config.identity.senderKind).some(
              (channel) => channel.id === valid.broadcasterId,
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
    const valid = yield* Schema.decodeUnknownEffect(Dispatch)(input).pipe(
      Effect.mapError(() => new AccountError({ code: "input" })),
    );

    const fingerprint = yield* digest(JSON.stringify(valid));
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

        return { kind: "ambiguous" } satisfies DispatchOutcome;
      }

      if (previous && previous.fingerprint !== fingerprint)
        return { kind: "rejected" } satisfies DispatchOutcome;

      const recorded = Match.value(previous).pipe(
        Match.when(Predicate.isUndefined, () => null),
        Match.discriminatorsExhaustive("kind")({
          terminal: (previous) => previous.outcome,
          sending: (previous): DispatchOutcome => {
            if (previous.instance !== instance || first >= previous.deadline)
              state.attempts[valid.attemptId] = {
                ...previous,
                kind: "terminal",
                outcome: { kind: "ambiguous" },
                privateCode: "interrupted",
              };

            return { kind: "ambiguous" };
          },
          waiting: () => null,
        }),
      );

      if (recorded) return recorded;

      if (first >= valid.deadline)
        return { kind: "expired" } satisfies DispatchOutcome;

      if (!current(state))
        return { kind: "rejected" } satisfies DispatchOutcome;

      return null;
    });

    if (read) return read;

    const usable = yield* store.channelDispatch(
      valid.broadcasterId,
      (state) => {
        for (const [id, entry] of Object.entries(state.revoked))
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

    const session = yield* appToken().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

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
        const owner = crypto.randomUUID();

        const claimed = yield* store.channelDispatch(
          valid.broadcasterId,
          (state) => {
            reclaimSend(state, now);

            for (const [key, tombstone] of Object.entries(state.revoked))
              if (tombstone.until <= now && tombstone.deleteDue === null)
                delete state.revoked[key];
            const prior = state.attempts[valid.attemptId];

            if (prior && prior.fingerprint !== fingerprint)
              return {
                kind: "outcome",
                outcome: { kind: "rejected" },
              } as const;

            const recorded = Match.value(prior).pipe(
              Match.when(Predicate.isUndefined, () => null),
              Match.discriminatorsExhaustive("kind")({
                terminal: (prior) => prior.outcome,
                sending: (): DispatchOutcome => ({ kind: "ambiguous" }),
                waiting: () => null,
              }),
            );

            if (recorded)
              return { kind: "outcome", outcome: recorded } as const;

            if (now >= valid.deadline)
              return { kind: "outcome", outcome: { kind: "expired" } } as const;
            const retainUntil = valid.deadline + policy.retentionMs;

            if (
              !prior &&
              Object.keys(state.attempts).length >= policy.maxAttempts
            ) {
              const availableAt = Math.min(
                ...Object.values(state.attempts).map(
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

            const channel = desiredChannels(
              state,
              config.identity.senderKind,
            ).find((channel) => channel.id === valid.broadcasterId);

            const sender = state.sender;
            const life = state.lifecycle[valid.broadcasterId];

            if (
              life?.kind !== "installed" ||
              life.id !== valid.source.installationId ||
              state.subscriptions[valid.broadcasterId]?.id !==
                valid.source.subscriptionId ||
              !channel ||
              !sender ||
              decideChannel(state, channel.id).kind !== "ready"
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

            const retryAt = reserveAt(state, channel.id, now);

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
              { channel: channel.id, at: now },
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
    credentialAlarm: () => alarm,
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
