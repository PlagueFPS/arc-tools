import { Schema } from "effect";

const ComponentSchema = Schema.Struct({
  quantity: Schema.Number,
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
  trader_price: Schema.Number,
});

export class TradersAPIResponse extends Schema.Class<TradersAPIResponse>(
  "TradersAPIResponse",
)({
  data: Schema.Struct({
    Apollo: Schema.Array(TraderItemSchema),
    Celeste: Schema.Array(TraderItemSchema),
    Lance: Schema.Array(TraderItemSchema),
    Shani: Schema.Array(TraderItemSchema),
    TianWen: Schema.Array(TraderItemSchema),
  }),
}) {}

export class Arc extends Schema.Class<Arc>("Arc")({
  id: Schema.String,
  name: Schema.String,
  loot: Schema.OptionFromNullishOr(Schema.Array(ArcLootSchema)),
}) {}
export class ArcsAPIResponse extends Schema.Class<ArcsAPIResponse>(
  "ArcsAPIResponse",
)({
  data: Schema.Array(Arc),
}) {}

export class Item extends Schema.Class<Item>("Item")({
  id: Schema.String,
  name: Schema.String,
  value: Schema.Number,
  workbench: Schema.OptionFromNullishOr(Schema.String),
  loot_area: Schema.OptionFromNullishOr(Schema.String),
  components: Schema.OptionFromNullishOr(Schema.Array(ComponentSchema)),
  recycle_components: Schema.OptionFromNullishOr(Schema.Array(ComponentSchema)),
  recycle_from: Schema.OptionFromNullishOr(
    Schema.Array(
      Schema.Struct({
        quantity: Schema.Number,
        item: Schema.Struct({
          id: Schema.String,
          name: Schema.String,
        }),
      }),
    ),
  ),
  dropped_by: Schema.OptionFromNullishOr(
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

export class ItemAPIResponse extends Schema.Class<ItemAPIResponse>(
  "ItemAPIResponse",
)({
  data: Schema.Array(Item),
}) {}

export class Event extends Schema.Class<Event>("Event")({
  name: Schema.String,
  map: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.Number,
}) {}
export class EventAPIResponse extends Schema.Class<EventAPIResponse>(
  "EventAPIResponse",
)({
  data: Schema.Array(Event),
}) {}
