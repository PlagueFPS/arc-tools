import { BASE_API_URL } from "@arctools/utils";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { TradersAPIResponse } from "./schema";

/**
 * Fetches the traders from the API
 * @returns The traders data
 */
export const fetchTraders = () =>
  Effect.gen(function* () {
    const url = `${BASE_API_URL}/traders`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TradersAPIResponse)),
      );
    return response.data;
  });
