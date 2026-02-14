import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { ItemAPIResponse } from "@/data/schema";

interface ItemAPIParams {
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

const BASE_URL = "https://metaforge.app/api/arc-raiders";

/**
 * Fetches an item from the API
 * @param searchParams - The search parameters
 * @returns The item data based on search params
 */
export const fetchItem = (searchParams: ItemAPIParams) =>
  Effect.gen(function* () {
    const params = new URLSearchParams(Object.entries(searchParams));
    const url = `${BASE_URL}/items?${params.toString()}`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemAPIResponse)));
    return response.data[0];
  });
