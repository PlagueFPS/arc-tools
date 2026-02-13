import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { ItemAPIResponse } from "@/data/schema";

const BASE_URL = "https://metaforge.app/api/arc-raiders";

/**
 * Parses the message parameters into a formatted string
 * @param params - The parameters to parse
 * @returns The formatted string
 */
export const parseMessageParams = (params: string[]) =>
  params
    .map((param) => param.trim())
    .filter(Boolean)
    .join(" ");

/**
 * Fetches an item from the API
 * @param searchParams - The search parameters
 * @returns The item data based on search params
 */
export const fetchItem = (searchParams: Record<string, string>) =>
  Effect.gen(function* () {
    const params = new URLSearchParams(searchParams);
    const url = `${BASE_URL}/items?${params.toString()}`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemAPIResponse)));
    return response.data[0];
  });
