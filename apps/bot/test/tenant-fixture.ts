/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each isolated test or fixture is an entry point that owns its injected layer scope. */
import { ArcData } from "@arctools/arc-data";
import { makeFixture } from "@arctools/arc-data/testing";
import {
  type Account,
  AccountError,
  type Dispatch,
  type DispatchOutcome,
  TwitchAccount,
} from "@arctools/twitch/server";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Effect,
  Exit,
  Schema,
  Semaphore,
  String as EffectString,
} from "effect";

import { DiscordReceipt, TwitchReceipt } from "../src/tenant-contracts.js";
import { emptyTenant, TenantState, TenantStore } from "../src/tenant-state.js";
import {
  tenantStorageLayer,
  TenantService,
  tenantServiceLayer,
} from "../src/tenant.js";

export const twitchReceipt = (id = "work", receivedAt = 0) =>
  Schema.decodeSync(TwitchReceipt)({
    id,
    fingerprint: EffectString.repeat(64)("a"),
    receivedAt,
    broadcasterId: "200",
    source: {
      installationId: "fixture-install",
      subscriptionId: "fixture-sub",
    },
    replyParentId: "parent",
    invocation: { command: "sell", input: "sensors" },
  });

export const discordReceipt = (id = "work", receivedAt = 0) =>
  Schema.decodeSync(DiscordReceipt)({
    id,
    fingerprint: EffectString.repeat(64)("a"),
    receivedAt,
    guildId: "guild",
    invocation: { command: "sell", input: "sensors" },
  });

export const tenantFixture = Effect.fnUntraced(function* () {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let deletions = 0;
  let inTransaction = false;
  let beforeDelete: Effect.Effect<void> = Effect.void;
  const mutex = yield* Semaphore.make(1);
  const launches: Effect.Effect<void>[] = [];
  const sent: Dispatch[] = [];
  const ledger = new Map<string, DispatchOutcome>();

  let dispatch = (
    input: Dispatch,
  ): Effect.Effect<DispatchOutcome, AccountError> =>
    Effect.sync(() => {
      sent.push(input);

      const outcome = ledger.get(input.attemptId) ?? {
        kind: "sent",
        messageId: "sent",
      };

      ledger.set(input.attemptId, outcome);

      return outcome;
    });

  const account: Account = {
    dispatch: (input) => dispatch(input),
    setup: () => new AccountError({ code: "configuration" }),
    completeOAuth: () => new AccountError({ code: "configuration" }),
    status: new AccountError({ code: "configuration" }),
    observeSubscription: () => Effect.succeed(null),
  };

  const store = yield* TenantStore.pipe(
    Effect.provide(
      tenantStorageLayer({
        get: (key) => Effect.sync(() => structuredClone(values.get(key))),
        put: (key, value) =>
          Effect.sync(() => {
            values.set(key, structuredClone(value));
          }),
        deleteAll: () =>
          Effect.gen(function* () {
            yield* beforeDelete;

            if (inTransaction)
              throw new Error("Cannot call deleteAll() within a transaction");
            values.clear();
            alarm = null;
            deletions++;
          }),
        getAlarm: () => Effect.sync(() => alarm),
        setAlarm: (at) =>
          Effect.sync(() => {
            alarm = Number(at);
          }),
        deleteAlarm: () =>
          Effect.sync(() => {
            alarm = null;
          }),
        transaction: (effect) =>
          Effect.gen(function* () {
            const before = structuredClone(values);
            const beforeAlarm = alarm;
            inTransaction = true;
            const exit = yield* Effect.exit(effect);
            inTransaction = false;

            if (Exit.isFailure(exit)) {
              values.clear();

              for (const [key, value] of before) values.set(key, value);
              alarm = beforeAlarm;

              return yield* Effect.failCause(exit.cause);
            }

            return exit.value;
          }).pipe((effect) => mutex.withPermit(effect)),
      }),
    ),
    Effect.provideService(
      RuntimeContext,
      RuntimeContext.of({
        Type: "test",
        id: "tenant-storage",
        env: {},
        get: () => Effect.as(Effect.void, undefined),
        set: (key) => Effect.succeed(key),
      }),
    ),
  );

  const source = yield* makeFixture();

  const construct = (
    activation = "first",
    data: typeof ArcData.Service = source.data,
    storage: typeof TenantStore.Service = store,
  ) =>
    TenantService.pipe(
      Effect.provide(
        tenantServiceLayer({
          activation,
          launch: (effect) =>
            Effect.sync(() => {
              launches.push(effect);
            }),
        }),
      ),
      Effect.provideService(TenantStore, storage),
      Effect.provideService(ArcData, data),
      Effect.provideService(TwitchAccount, account),
    );

  return {
    source,
    store,
    construct,
    sent,
    ledger,
    launches,
    snapshot: () =>
      Schema.decodeUnknownSync(TenantState)(
        values.get("tenant:v1") ?? emptyTenant(),
      ),
    values,
    deletions: () => deletions,
    beforeDelete: (effect: Effect.Effect<void>) => {
      beforeDelete = effect;
    },
    alarm: () => alarm,
    dispatch: (next: typeof dispatch) => {
      dispatch = next;
    },
    drain: Effect.suspend(() =>
      Effect.forEach(launches.splice(0), (effect) => effect, {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  };
});
