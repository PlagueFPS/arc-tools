import { Schema } from "effect";

const ComponentSchema = Schema.Struct({
  quantity: Schema.Finite,
  component: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
});

const ArcLootSchema = Schema.Struct({
  item: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
});

const TraderItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  trader_price: Schema.Finite,
});

export class TradersAPIResponse extends Schema.Class<
  TradersAPIResponse,
  { readonly brand: unique symbol }
>("TradersAPIResponse")({
  data: Schema.Struct({
    Apollo: Schema.Array(TraderItemSchema),
    Celeste: Schema.Array(TraderItemSchema),
    Lance: Schema.Array(TraderItemSchema),
    Shani: Schema.Array(TraderItemSchema),
    TianWen: Schema.Array(TraderItemSchema),
  }),
}) {}

export class Arc extends Schema.Class<Arc, { readonly brand: unique symbol }>(
  "Arc",
)({
  id: Schema.String,
  name: Schema.String,
  loot: Schema.OptionFromOptionalNullOr(Schema.Array(ArcLootSchema)),
}) {}

export class ArcsAPIResponse extends Schema.Class<
  ArcsAPIResponse,
  { readonly brand: unique symbol }
>("ArcsAPIResponse")({
  data: Schema.Array(Arc),
}) {}

export class Item extends Schema.Class<Item, { readonly brand: unique symbol }>(
  "Item",
)({
  id: Schema.String,
  name: Schema.String,
  value: Schema.Finite,
  workbench: Schema.OptionFromOptionalNullOr(Schema.String),
  loot_area: Schema.OptionFromOptionalNullOr(Schema.String),
  components: Schema.OptionFromOptionalNullOr(Schema.Array(ComponentSchema)),
  recycle_components: Schema.OptionFromOptionalNullOr(
    Schema.Array(ComponentSchema),
  ),
  recycle_from: Schema.OptionFromOptionalNullOr(
    Schema.Array(
      Schema.Struct({
        quantity: Schema.Finite,
        item: Schema.Struct({
          id: Schema.String,
          name: Schema.String,
        }),
      }),
    ),
  ),
  dropped_by: Schema.OptionFromOptionalNullOr(
    Schema.Array(
      Schema.Struct({
        arc: Schema.Struct({
          id: Schema.String,
          name: Schema.String,
        }),
      }),
    ),
  ),
}) {}

export class ItemAPIResponse extends Schema.Class<
  ItemAPIResponse,
  { readonly brand: unique symbol }
>("ItemAPIResponse")({
  data: Schema.Array(Item),
}) {}

export class Event extends Schema.Class<
  Event,
  { readonly brand: unique symbol }
>("Event")({
  name: Schema.String,
  map: Schema.String,
  startTime: Schema.Finite,
  endTime: Schema.Finite,
}) {}

export class EventAPIResponse extends Schema.Class<
  EventAPIResponse,
  { readonly brand: unique symbol }
>("EventAPIResponse")({
  data: Schema.Array(Event),
}) {}
