import { Schema } from "effect";

export class Item extends Schema.Class<Item>("Item")({
  id: Schema.String,
  name: Schema.String,
  value: Schema.Number,
  loot_area: Schema.OptionFromNullishOr(Schema.String, null),
  recycle_components: Schema.OptionFromNullishOr(
    Schema.Array(
      Schema.Struct({
        quantity: Schema.Number,
        component: Schema.Struct({
          id: Schema.String,
          name: Schema.String,
        }),
      }),
    ),
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
}) {}

export class ItemAPIResponse extends Schema.Class<ItemAPIResponse>(
  "ItemAPIResponse",
)({
  data: Schema.Array(Item),
}) {}
