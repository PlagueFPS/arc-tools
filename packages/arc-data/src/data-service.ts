import { Context, type Effect, Schema } from "effect";

import type { Arc, Event, Item, TradersAPIResponse } from "./schema.js";

const QueryText = Schema.String.check(Schema.isMaxLength(256));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
export const ItemParams = Schema.Struct({
  id: Schema.optional(QueryText),
  search: Schema.optional(QueryText),
  includeComponents: Schema.optional(Schema.Boolean),
  minimal: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Limit),
});
export type ItemAPIParams = typeof ItemParams.Type;
export const ArcParams = Schema.Struct({
  id: Schema.optional(QueryText),
  search: Schema.optional(QueryText),
  includeLoot: Schema.optional(Schema.Boolean),
});
export type ArcsAPIParams = typeof ArcParams.Type;
export const ResourceQuery = Schema.Union([
  Schema.Struct({ resource: Schema.Literal("items"), params: ItemParams }),
  Schema.Struct({ resource: Schema.Literal("arcs"), params: ArcParams }),
  Schema.Struct({ resource: Schema.Literal("traders") }),
  Schema.Struct({ resource: Schema.Literal("events-schedule") }),
]);
export type ResourceQuery = typeof ResourceQuery.Type;
export const Provenance = Schema.Struct({
  freshness: Schema.Literals(["fresh", "fallback"]),
  fetchedAt: Schema.Number,
});
export type Provenance = typeof Provenance.Type;
export interface DataRead<A> {
  readonly value: A;
  readonly provenance: Provenance;
}
export class DataUnavailable extends Schema.TaggedError<DataUnavailable>()(
  "DataUnavailable",
  {
    resource: Schema.String,
    reason: Schema.Literals([
      "query",
      "source",
      "capacity",
      "refreshing",
      "superseded",
      "deadline",
    ]),
  },
) {
  get message() {
    return "Game data is temporarily unavailable. Please try again shortly.";
  }
}

export interface Interface {
  readonly items: (
    params: ItemAPIParams,
  ) => Effect.Effect<DataRead<readonly Item[]>, DataUnavailable>;
  readonly arcs: (
    params: ArcsAPIParams,
  ) => Effect.Effect<DataRead<readonly Arc[]>, DataUnavailable>;
  readonly traders: () => Effect.Effect<
    DataRead<TradersAPIResponse["data"]>,
    DataUnavailable
  >;
  readonly events: () => Effect.Effect<
    DataRead<readonly Event[]>,
    DataUnavailable
  >;
}
export class ArcData extends Context.Service<ArcData, Interface>()(
  "@arctools/ArcData",
) {}
