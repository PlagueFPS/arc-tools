import { Option, Predicate, Schema, SchemaTransformation } from "effect";

/**
 * Schema for an optional key that may contain a nullish (null/undefined) value.
 * Produces a single Option<T> instead of Option<Option<T>>.
 *
 * Handles: missing key, undefined, null → Option.none()
 * Handles: present value → Option.some(value)
 *
 * @see Effect SCHEMA.md "Optional Property with Nullability"
 */
const OptionFromOptionalNullish = <S extends Schema.Schema<unknown>>(
  schema: S,
) =>
  Schema.optionalKey(Schema.NullishOr(schema)).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(schema)),
      SchemaTransformation.transformOptional({
        decode: (oe) =>
          oe.pipe(Option.filter(Predicate.isNotNullish), Option.some),
        encode: Option.flatten,
      }) as any, // biome-lint()
    ),
  );

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
  workbench: OptionFromOptionalNullish(Schema.String),
  loot_area: OptionFromOptionalNullish(Schema.String),
  components: OptionFromOptionalNullish(Schema.Array(ComponentSchema)),
  recycle_components: OptionFromOptionalNullish(Schema.Array(ComponentSchema)),
  recycle_from: OptionFromOptionalNullish(
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
  dropped_by: OptionFromOptionalNullish(
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
