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

export class Arc extends Schema.Class<Arc>("Arc")({
  id: Schema.String,
  name: Schema.String,
  loot: Schema.OptionFromNullishOr(Schema.Array(ArcLootSchema), null),
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
  workbench: Schema.OptionFromNullishOr(Schema.String, null),
  loot_area: Schema.OptionFromNullishOr(Schema.String, null),
  components: Schema.OptionFromNullishOr(Schema.Array(ComponentSchema), null),
  recycle_components: Schema.OptionFromNullishOr(
    Schema.Array(ComponentSchema),
    null,
  ),
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
    null,
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
    null,
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
