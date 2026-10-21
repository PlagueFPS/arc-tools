import { ArcData } from "@arctools/arc-data";
import { makeFixture } from "@arctools/arc-data/testing";
import {
  type Account,
  AccountError,
  type Dispatch,
  type DispatchOutcome,
  TwitchAccount,
} from "@arctools/twitch/server";
import { Effect, Schema } from "effect";

import { DiscordReceipt, TwitchReceipt } from "../src/tenant-contracts.js";
import {
  emptyTenant,
  nextAlarm,
  TenantState,
  TenantStore,
} from "../src/tenant-state.js";
import { TenantService, tenantServiceLayer } from "../src/tenant.js";

export const twitchReceipt = (id = "work", receivedAt = 0) =>
  Schema.decodeUnknownSync(TwitchReceipt)({
    id,
    fingerprint: "a".repeat(64),
    receivedAt,
    broadcasterId: "200",
    replyParentId: "parent",
    invocation: { command: "sell", input: "sensors" },
  });

export const discordReceipt = (id = "work", receivedAt = 0) =>
  Schema.decodeUnknownSync(DiscordReceipt)({
    id,
    fingerprint: "a".repeat(64),
    receivedAt,
    guildId: "guild",
    invocation: { command: "sell", input: "sensors" },
  });

export const tenantFixture = Effect.fnUntraced(function* () {
  let raw: unknown = emptyTenant();
  let alarm: number | null = null;
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
    status: () => new AccountError({ code: "configuration" }),
    observeSubscription: () => Effect.void,
  };

  const store = TenantStore.of({
    read: Effect.sync(() => Schema.decodeUnknownSync(TenantState)(raw)),
    update: (f) =>
      Effect.sync(() => {
        const state = Schema.decodeUnknownSync(TenantState)(raw);
        const result = f(state);
        raw = Schema.encodeSync(TenantState)(state);
        alarm = nextAlarm(state);

        return result;
      }),
  });

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
    ).pipe(
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
    snapshot: () => Schema.decodeUnknownSync(TenantState)(raw),
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
