import { Context, type Effect, Match, Schema } from "effect";

import { BroadcasterId, Deadline, WorkId } from "./contracts.js";
import { DiscordResponse, encodedBytes } from "./presentation.js";
import { Invocation } from "./tenant-contracts.js";
import { Dispatch, ReplyId } from "./twitch-contracts.js";

export const tenantPolicy = {
  retained: 64,
  active: 8,
  bytes: 120 * 1024,
  reservation: 8 * 1024,
  retentionMs: 600_000,
  leaseMs: 4000,
  deliveryLeaseMs: 1000,
  computeMs: 2350,
  rpcMs: 2700,
} as const;

const Claim = Schema.Struct({
  generation: Schema.Int,
  activation: Schema.String,
  until: Schema.Number,
});

export type Claim = typeof Claim.Type;

const common = {
  id: WorkId,
  fingerprint: Schema.String,
  receivedAt: Schema.Number,
  deadline: Deadline,
  retainUntil: Schema.Number,
};

const twitch = { ...common, transport: Schema.Literal("twitch") };

const computation = {
  invocation: Invocation,
  broadcasterId: BroadcasterId,
  replyParentId: ReplyId,
};

const plan = {
  plan: Schema.NonEmptyArray(Dispatch).check(Schema.isMaxLength(8)),
  cursor: Schema.Int,
};

const TwitchWork = Schema.Union([
  Schema.Struct({
    ...twitch,
    kind: Schema.Literal("accepted"),
    ...computation,
  }),
  Schema.Struct({
    ...twitch,
    kind: Schema.Literal("computing"),
    ...computation,
    claim: Claim,
  }),
  Schema.Struct({
    ...twitch,
    kind: Schema.Literal("ready"),
    ...plan,
    retryAt: Schema.Number,
  }),
  Schema.Struct({
    ...twitch,
    kind: Schema.Literal("delivering"),
    ...plan,
    claim: Claim,
  }),
  Schema.Struct({
    ...twitch,
    kind: Schema.Literal("terminal"),
    outcome: Schema.Literals(["sent", "rejected", "ambiguous", "expired"]),
  }),
]);

const DiscordWork = Schema.Union([
  Schema.Struct({
    ...common,
    transport: Schema.Literal("discord"),
    kind: Schema.Literal("computing"),
    invocation: Invocation,
    claim: Claim,
  }),
  Schema.Struct({
    ...common,
    transport: Schema.Literal("discord"),
    kind: Schema.Literal("terminal"),
    response: DiscordResponse,
  }),
]);

export const Work = Schema.Union([TwitchWork, DiscordWork]);

export type Work = typeof Work.Type;

export const TenantState = Schema.Struct({
  tenant: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  works: Schema.Record(Schema.String, Work),
});

type Persisted = typeof TenantState.Type;

export type TenantState = {
  -readonly [K in keyof Persisted]: K extends "works"
    ? { -readonly [P in keyof Persisted[K]]: Persisted[K][P] }
    : Persisted[K];
};

export const emptyTenant = (): TenantState => ({
  tenant: null,
  generation: 0,
  works: {},
});

export const sameClaim = (a: Claim, b: Claim) =>
  a.generation === b.generation &&
  a.activation === b.activation &&
  a.until === b.until;

export function reclaim(state: TenantState, now: number) {
  for (const [id, work] of Object.entries(state.works))
    if (work.retainUntil <= now) delete state.works[id];
}

export function fits(state: TenantState) {
  const works = Object.values(state.works);

  const reserved =
    works.filter(
      (work) => work.kind === "computing" || work.kind === "accepted",
    ).length * tenantPolicy.reservation;

  return (
    works.length <= tenantPolicy.retained &&
    works.filter((work) => work.kind !== "terminal").length <=
      tenantPolicy.active &&
    encodedBytes(state) + reserved <= tenantPolicy.bytes
  );
}

export function nextAlarm(state: TenantState): number | null {
  let next = Infinity;

  for (const work of Object.values(state.works)) {
    if (work.transport !== "twitch" || work.kind === "terminal") continue;

    const action = Match.value(work).pipe(
      Match.discriminatorsExhaustive("kind")({
        accepted: (work) => work.receivedAt,
        ready: (work) => work.retryAt,
        computing: (work) => work.claim.until,
        delivering: (work) => work.claim.until,
      }),
    );

    next = Math.min(next, action, work.deadline);
  }

  return Number.isFinite(next) ? next : null;
}

export interface Store {
  readonly read: Effect.Effect<TenantState>;
  readonly update: <A>(f: (state: TenantState) => A) => Effect.Effect<A>;
}

export class TenantStore extends Context.Service<TenantStore, Store>()(
  "@arctools/TenantStore",
) {}
