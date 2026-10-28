import { Effect } from "effect";

import { ArcData } from "./data-service.js";

export const getTraders = Effect.fn("ArcData.getTraders")(function* () {
  const data = yield* ArcData;
  const result = yield* data.traders;

  return result.value;
});
