import { digest } from "@arctools/utils/http";
import {
  Context,
  Clock,
  Effect,
  Layer,
  Match,
  Predicate,
  Schema,
  Semaphore,
} from "effect";

import {
  AccountError,
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
  AccountStore,
  desiredChannels,
  policy,
  reclaim,
  reserveAt,
} from "./state.js";

export const senderScopes = ["user:read:chat", "user:write:chat", "user:bot"];

export const broadcasterScopes = ["channel:bot"];

export interface AccountIdentity {
  readonly kind: "production" | "personal" | "test";
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

const granted = (state: AccountState, id: string, scopes: readonly string[]) =>
  scopes.every((scope) => state.grants[id]?.includes(scope));

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

const liveSubscription = (status: string) =>
  status === "enabled" || status === "webhook_callback_verification_pending";

export const makeAccount = Effect.fnUntraced(function* (config: AccountConfig) {
  const store = yield* AccountStore;
  const provider = yield* TwitchProvider;
  const tokenLock = yield* Semaphore.make(1);
  const instance = crypto.randomUUID();
  let validatedGeneration = "";
  const current = (state: AccountState) => state.revision === config.revision;

  const matchesTarget = (
    state: AccountState,
    record: AccountState["subscriptions"][string],
  ) =>
    current(state) &&
    desiredChannels(state, config.identity.kind).some(
      (channel) => channel.id === record.broadcasterId,
    ) &&
    state.sender?.id === record.senderId &&
    record.callback === config.callback &&
    record.binding === config.subscriptionBinding;

  const decideChannel = (state: AccountState, id: string) => {
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
      !desiredChannels(state, config.identity.kind).some(
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

  const revokeSubscription = (
    state: AccountState,
    observation: Pick<
      AccountState["subscriptions"][string],
      "id" | "broadcasterId" | "senderId" | "status"
    >,
    now: number,
  ) => {
    const prior = state.revoked[observation.id];
    const authorizationLost = observation.status === "authorization_revoked";

    if (
      prior?.reason === "authorization-revoked" ||
      (prior?.reason === "revoked" && !authorizationLost)
    )
      return;
    state.revoked[observation.id] = {
      until: prior?.until ?? now + policy.retentionMs,
      reason: authorizationLost ? "authorization-revoked" : "revoked",
    };

    const publicOnly =
      observation.broadcasterId !== state.sender?.id &&
      state.publicMembers.some(
        (member) => member.id === observation.broadcasterId,
      ) &&
      !state.channels.some(
        (channel) => channel.id === observation.broadcasterId,
      );

    if (publicOnly) {
      state.publicRevocationGeneration += 1;
      state.publicMembers = state.publicMembers.map((member) =>
        member.id === observation.broadcasterId
          ? {
              ...member,
              revocationGeneration: state.publicRevocationGeneration,
            }
          : member,
      );
      state.setupLease = null;
    } else state.authGeneration += 1;
    const record = state.subscriptions[observation.broadcasterId];

    if (record?.id === observation.id && matchesTarget(state, record))
      state.subscriptions[observation.broadcasterId] = {
        ...record,
        status: observation.status,
      };

    if (
      state.publicMembers.some(
        (member) => member.id === observation.broadcasterId,
      ) &&
      state.repair.kind !== "scheduled"
    )
      state.repair = { kind: "required" };

    if (authorizationLost) {
      delete state.grants[observation.broadcasterId];

      if (!publicOnly) delete state.grants[observation.senderId];
    }
  };

  yield* store.update((state) => {
    if (!current(state)) {
      state.revision = config.revision;
      state.authGeneration += 1;
      state.sender = null;
      state.channels = [];
      state.grants = {};
      state.oauth = [];
      state.enrollments = state.enrollments.map((entry) => ({
        ...entry,
        phase: { kind: "failed", reason: "authorization-required" },
      }));
      state.repair = { kind: "idle" };
      state.session = null;
      state.setupLease = null;
      state.tokenLease = null;
      state.tokenRetryAt = 0;
      state.credentialFailures = 0;
      state.nextCredentialCheck = null;
    }
  });

  const invalidateSession = (state: AccountState, generation: string) => {
    if (current(state) && state.session?.generation === generation) {
      state.session = null;
      state.tokenLease = null;
      state.tokenRetryAt = 0;
      state.nextCredentialCheck = null;
    }
  };

  const invalidate = (generation: string) =>
    store.update((state) => invalidateSession(state, generation));

  const appToken = Effect.fn("TwitchAccount.token")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const owner = crypto.randomUUID();

      const claim = yield* store.update((state) => {
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

              const accepted = yield* store.update((state) => {
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
                store.update((state) => {
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
  yield* store.update((state) => {
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

        const decisions = desiredChannels(state, config.identity.kind).map(
          (channel) => decideChannel(state, channel.id),
        );

        const channels = desiredChannels(state, config.identity.kind).map(
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
      const now = yield* Clock.currentTimeMillis;

      const retired = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, now)) return false;
        state.revoked[id] ??= {
          until: now + policy.retentionMs,
          reason: "retired",
        };

        for (const [channel, record] of Object.entries(state.subscriptions))
          if (record.id === id) delete state.subscriptions[channel];

        return true;
      });

      if (!retired) return yield* new AccountError({ code: "stale" });
      yield* assertOwner();
      yield* provider.remove(token, id);
    });

    yield* assertOwner();
    const remote = yield* provider.list(token);
    const now = yield* Clock.currentTimeMillis;

    const cleanup = yield* store.update((state) => {
      if (!ownsSetup(state, owner, generation, now)) return null;
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

        const owned = Object.values(state.subscriptions).some((local) =>
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
          subscription.status === "authorization_revoked"
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
    });

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
          !desiredChannels(state, config.identity.kind).some(
            (entry) => entry.id === channel,
          )
        )
          return "keep";

        return decideChannel(state, channel).confirmed ? "keep" : "create";
      });

      if (action === "stale") return yield* new AccountError({ code: "stale" });

      if (action === "keep") continue;
      const result = yield* provider.create(token, channel, sender);
      const completed = yield* Clock.currentTimeMillis;

      const accepted = yield* store.update((state) => {
        if (!ownsSetup(state, owner, generation, completed)) return false;

        if (result.kind === "created") {
          const record = result.subscription;

          if (
            record.broadcasterId === channel &&
            matchesTarget(state, record) &&
            !state.revoked[record.id]
          )
            state.subscriptions[channel] = record;
        }

        return true;
      });

      if (!accepted) return yield* new AccountError({ code: "stale" });
    }
  });

  const setup = Effect.fn("TwitchAccount.setup")(function* (
    operator: string,
  ): Effect.fn.Return<SetupResult, AccountError> {
    if (
      config.identity.channelLogins.length > policy.maxChannels ||
      !Schema.is(CallbackUrl)(config.callback) ||
      !Schema.is(CallbackUrl)(config.redirect)
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
            },
            config.identity.kind,
          ).length > policy.maxChannels
        )
          return "capacity";
        state.sender = sender;
        state.channels = resolved;

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
              desiredChannels(state, config.identity.kind)
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
        account.authGeneration !== state.generation
      )
        return false;
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

      if (config.identity.kind !== "production")
        return { kind: "failed", reason: "unavailable" };

      if (!entry || entry.expiresAt <= now)
        return { kind: "failed", reason: "expired" };

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

          const member = desiredChannels(state, config.identity.kind).find(
            (channel) => channel.id === id,
          );

          if (
            !member ||
            !state.sender ||
            !granted(state, state.sender.id, senderScopes) ||
            !granted(state, id, broadcasterScopes)
          )
            return { kind: "failed", reason: "authorization-required" };
          const decision = decideChannel(state, id);

          if (decision.kind === "ready")
            return { kind: "ready", login: member.login };

          if (
            decision.kind === "repair-required" ||
            state.repair.kind === "required"
          )
            return { kind: "failed", reason: "repair-required" };

          return { kind: "pending" };
        }
      }
    });
  });

  const beginEnrollment = Effect.fnUntraced(function* (input: EnrollmentBegin) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentBegin)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    if (
      config.identity.kind !== "production" ||
      !config.webhookReady ||
      !Schema.is(CallbackUrl)(config.callback) ||
      !Schema.is(CallbackUrl)(config.redirect)
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
      const active = retained.filter((entry) => entry.phase.kind !== "failed");

      const failureSlots =
        policy.maxChannels + policy.maxEnrollmentIntents - active.length - 1;

      const failures = retained
        .filter((entry) => entry.phase.kind === "failed")
        .slice(0, failureSlots);

      state.enrollments = [
        ...active,
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

    if (config.identity.kind !== "production")
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
          (member?.revocationGeneration ?? 0) >
          claimed.entry.publicRevocationGeneration
        )
          return "state";

        const existing = desiredChannels(state, config.identity.kind).find(
          (channel) => channel.id === userId,
        );

        if (
          !existing &&
          desiredChannels(state, config.identity.kind).length >=
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
            { id: userId, login, revocationGeneration: 0 },
          ];
        else
          state.publicMembers = state.publicMembers.map((member) =>
            member.id === userId ? { ...member, login } : member,
          );
        state.grants[userId] = [
          ...new Set([...(state.grants[userId] ?? []), ...broadcasterScopes]),
        ];
        state.enrollments = state.enrollments
          .filter(
            (candidate) =>
              candidate === entry ||
              candidate.phase.kind !== "member" ||
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
        state.repair = {
          kind: "scheduled",
          id: owner,
          due: completed + 1,
          attempts: 0,
        };

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
    const owner = crypto.randomUUID();

    const claim = yield* store.update((state) => {
      if (
        !current(state) ||
        state.repair.kind !== "scheduled" ||
        state.repair.due > now
      )
        return null;

      if (state.repair.attempts >= policy.maxRepairAttempts) {
        state.repair = { kind: "required" };

        return null;
      }

      if (state.setupLease && state.setupLease.until > now) {
        state.repair = { ...state.repair, due: state.setupLease.until + 1 };

        return null;
      }

      if (
        config.identity.kind !== "production" ||
        !config.webhookReady ||
        !state.sender ||
        !granted(state, state.sender.id, senderScopes)
      ) {
        state.repair = { kind: "required" };

        return null;
      }

      state.setupLease = {
        owner,
        until: now + policy.setupLeaseMs,
        revision: config.revision,
        generation: state.authGeneration,
      };

      const claim = {
        id: state.repair.id,
        generation: state.authGeneration,
        sender: state.sender.id,
        channels: desiredChannels(state, config.identity.kind)
          .filter((channel) => granted(state, channel.id, broadcasterScopes))
          .map((channel) => channel.id),
        attempts: state.repair.attempts + 1,
      };

      state.repair = {
        kind: "scheduled",
        id: claim.id,
        due: now + policy.setupLeaseMs + 1,
        attempts: claim.attempts,
      };

      return claim;
    });

    if (!claim) return;
    yield* Effect.gen(function* () {
      const session = yield* appToken();
      yield* reconcile(
        owner,
        session.token,
        claim.sender,
        claim.channels,
        claim.generation,
      ).pipe(
        Effect.tapError((error) =>
          error.code === "client"
            ? invalidate(session.generation)
            : Effect.void,
        ),
      );
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.ensuring(
        Effect.gen(function* () {
          const completed = yield* Clock.currentTimeMillis;
          yield* store.update((state) => {
            if (state.setupLease?.owner !== owner) return;
            state.setupLease = null;

            if (!current(state) || state.repair.kind !== "scheduled") return;

            if (state.repair.id !== claim.id) return;

            const ready = desiredChannels(state, config.identity.kind).every(
              (channel) => decideChannel(state, channel.id).kind === "ready",
            );

            state.repair = ready
              ? { kind: "idle" }
              : claim.attempts >= policy.maxRepairAttempts
                ? { kind: "required" }
                : {
                    kind: "scheduled",
                    id: claim.id,
                    due: completed + policy.repairRetryMs,
                    attempts: claim.attempts,
                  };
          });
        }),
      ),
    );
  });

  const observeSubscription = Effect.fn("TwitchAccount.subscription")(
    function* (input: SubscriptionObservation) {
      const valid = yield* Schema.decodeUnknownEffect(SubscriptionObservation)(
        input,
      ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

      const now = yield* Clock.currentTimeMillis;
      yield* store.update((state) => {
        if (!current(state)) return;

        if (
          valid.binding !== config.subscriptionBinding ||
          valid.callback !== config.callback ||
          state.sender?.id !== valid.senderId ||
          !desiredChannels(state, config.identity.kind).some(
            (channel) => channel.id === valid.broadcasterId,
          )
        )
          return;
        const record = state.subscriptions[valid.broadcasterId];

        const confirmed =
          record?.id === valid.id && matchesTarget(state, record);

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

          return;
        }

        revokeSubscription(state, valid, now);
      });
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

    const read = yield* store.update((state) => {
      reclaim(state, first);
      const previous = state.attempts[valid.attemptId];

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

    const session = yield* appToken().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    if (!session) {
      const now = yield* Clock.currentTimeMillis;

      return now + 1_000 < valid.deadline
        ? { kind: "retryable", retryAt: Deadline.make(now + 1_000) }
        : { kind: "expired" };
    }

    const now = yield* Clock.currentTimeMillis;
    const owner = crypto.randomUUID();

    const claimed = yield* store.update((state) => {
      reclaim(state, now);
      const prior = state.attempts[valid.attemptId];

      if (prior && prior.fingerprint !== fingerprint)
        return { kind: "outcome", outcome: { kind: "rejected" } } as const;

      const recorded = Match.value(prior).pipe(
        Match.when(Predicate.isUndefined, () => null),
        Match.discriminatorsExhaustive("kind")({
          terminal: (prior) => prior.outcome,
          sending: (): DispatchOutcome => ({ kind: "ambiguous" }),
          waiting: () => null,
        }),
      );

      if (recorded) return { kind: "outcome", outcome: recorded } as const;

      if (now >= valid.deadline)
        return { kind: "outcome", outcome: { kind: "expired" } } as const;
      const retainUntil = valid.deadline + policy.retentionMs;

      if (!prior && Object.keys(state.attempts).length >= policy.maxAttempts) {
        const availableAt = Math.min(
          ...Object.values(state.attempts).map(
            (attempt) => attempt.retainUntil,
          ),
        );

        if (availableAt < valid.deadline)
          return {
            kind: "outcome",
            outcome: { kind: "retryable", retryAt: Deadline.make(availableAt) },
          } as const;

        return { kind: "outcome", outcome: { kind: "expired" } } as const;
      }

      const channel = desiredChannels(state, config.identity.kind).find(
        (channel) => channel.id === valid.broadcasterId,
      );

      const sender = state.sender;

      if (
        !channel ||
        !sender ||
        decideChannel(state, channel.id).kind !== "ready"
      ) {
        state.attempts[valid.attemptId] = {
          kind: "terminal",
          fingerprint,
          deadline: valid.deadline,
          retainUntil,
          outcome: { kind: "rejected" },
          privateCode: "unavailable",
        };

        return { kind: "outcome", outcome: { kind: "rejected" } } as const;
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
            fingerprint,
            deadline: valid.deadline,
            retainUntil,
            outcome: { kind: "expired" },
            privateCode: "rate-deadline",
          };

          return { kind: "outcome", outcome: { kind: "expired" } } as const;
        }

        state.attempts[valid.attemptId] = {
          kind: "waiting",
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
        fingerprint,
        deadline: valid.deadline,
        retainUntil,
        owner,
        instance,
      };

      return { kind: "send", sender: sender.id } as const;
    });

    if (claimed.kind === "outcome") return claimed.outcome;
    const result = yield* provider.send(session.token, claimed.sender, valid);
    const completed = yield* Clock.currentTimeMillis;

    const outcome = yield* store.update((state): DispatchOutcome => {
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
            if (result.kind === "unauthorized")
              invalidateSession(state, session.generation);

            const retryAt =
              result.kind === "limited" ? result.retryAt : completed + 100;

            if (result.kind === "limited")
              state.apiBlockedUntil = Math.max(state.apiBlockedUntil, retryAt);

            if (retryAt < valid.deadline) {
              state.attempts[valid.attemptId] = {
                kind: "waiting",
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
  });

  const credentialAlarm = Effect.fnUntraced(function* () {
    const maintained = yield* store.update((state) => {
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
            yield* store.update((state) => {
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

  const alarm = credentialAlarm().pipe(Effect.andThen(repairMemberships));

  return {
    enrollment: TwitchEnrollment.of({
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
