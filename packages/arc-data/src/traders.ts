import { Effect } from "effect";
import { HttpClientResponse } from "effect/unstable/http";
import { TradersAPIResponse } from "./schema";
import { arcHttpClient } from "./utils";

/**
 * Fetches the traders from the API
 * @returns The traders data
 */
export const fetchTraders = Effect.fn("ArcData.fetchTraders")(function* () {
  const httpClient = yield* arcHttpClient;
  const response = yield* httpClient
    .get("/traders")
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TradersAPIResponse)),
    );
  return response.data;
});
