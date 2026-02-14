import { Schema } from "effect";

const ComponentSchema = Schema.Struct({
  quantity: Schema.Number,
  component: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
});

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
}) {}

export class ItemAPIResponse extends Schema.Class<ItemAPIResponse>(
  "ItemAPIResponse",
)({
  data: Schema.Array(Item),
}) {}
