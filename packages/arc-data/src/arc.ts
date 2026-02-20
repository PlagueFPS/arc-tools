import { BASE_API_URL } from "@arctools/utils";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { ArcsAPIResponse } from "./schema";

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
export const fetchArc = (searchParams: ArcsAPIParams) =>
  Effect.gen(function* () {
    const params = new URLSearchParams(
      Object.entries(searchParams)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)] as [string, string]),
    );
    params.set("includeLoot", "true");
    const url = `${BASE_API_URL}/arcs?${params.toString()}`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ArcsAPIResponse)));
    return response.data[0];
  });
