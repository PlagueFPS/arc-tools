import { Effect } from "effect";
import { HttpClientResponse } from "effect/unstable/http";
import { TradersAPIResponse } from "./schema";
import { arcHttpClient } from "./utils";

/**
 * Gets the traders from the API
 * @returns The traders data
 */
export const getTraders = Effect.fn("ArcData.getTraders")(function* () {
  const httpClient = yield* arcHttpClient;
  const response = yield* httpClient
    .get("/traders")
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TradersAPIResponse)),
    );
  return response.data;
});
