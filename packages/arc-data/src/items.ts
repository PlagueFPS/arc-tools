import { Array as Arr, Effect } from "effect";
import { HttpClientResponse, UrlParams } from "effect/unstable/http";
import { ItemAPIResponse } from "./schema";
import { arcHttpClient } from "./utils";

export interface ItemAPIParams {
  /** The ID of the item */
  id?: string;
  /** The search query for the item */
  search?: string;
  /** Whether to include components in the response */
  includeComponents?: boolean;
  /** The maximum number of items to return */
  limit?: number;
  /** Whether to return minimal data */
  minimal?: boolean;
}

/**
 * Fetches an item from the API
 * @param searchParams - The search parameters
 * @returns The item data based on search params
 */
export const fetchItem = Effect.fn("ArcData.fetchItem")(function* (
  searchParams: ItemAPIParams,
) {
  const httpClient = yield* arcHttpClient;
  const response = yield* httpClient
    .get("/items", {
      urlParams: UrlParams.fromInput(searchParams),
    })
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemAPIResponse)));
  return Arr.head(response.data);
});
