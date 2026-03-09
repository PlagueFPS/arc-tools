import { Array as Arr, Effect } from "effect";
import { HttpClientResponse, UrlParams } from "effect/unstable/http";
import { ArcsAPIResponse } from "./schema.js";
import { arcHttpClient } from "./utils.js";

export interface ArcsAPIParams {
  /** The ID of the arc */
  id?: string;
  /** The search query for the arc */
  search?: string;
}

/**
 * Fetches an arc from the API
 * @param searchParams - The search parameters
 * @returns The arc data based on search params
 */
export const fetchArc = Effect.fn("ArcData.fetchArc")(function* (
  searchParams: ArcsAPIParams,
) {
  const httpClient = yield* arcHttpClient;
  const response = yield* httpClient
    .get("/arcs", {
      urlParams: UrlParams.fromInput({
        ...searchParams,
        includeLoot: true,
      }),
    })
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ArcsAPIResponse)));
  return Arr.head(response.data);
});
