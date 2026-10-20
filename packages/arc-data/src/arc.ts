import { Array as Arr, Effect } from "effect";

import { ArcData, type ArcsAPIParams } from "./data-service.js";

export type { ArcsAPIParams } from "./data-service.js";

export const fetchArc = Effect.fn("ArcData.fetchArc")(function* (
  params: ArcsAPIParams,
) {
  const data = yield* ArcData;
  const result = yield* data.arcs(params);

  return Arr.head(result.value);
});
