import { BASE_API_URL } from "@arctools/utils";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const arcHttpClient = Effect.gen(function* () {
  return (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(BASE_API_URL),
        HttpClientRequest.acceptJson,
      ),
    ),
    HttpClient.filterStatusOk,
  );
});
