import { Array as Arr, Effect } from "effect";

import { ArcData, type ItemAPIParams } from "./data-service.js";

export type { ItemAPIParams } from "./data-service.js";

export const getItem = Effect.fn("ArcData.getItem")(function* (
  params: ItemAPIParams,
) {
  const data = yield* ArcData;
  const result = yield* data.items(params);

  return Arr.head(result.value);
});
