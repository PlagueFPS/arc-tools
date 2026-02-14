import { normalize } from "@arctools/utils";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { type Event, EventAPIResponse } from "./schema.js";

const BASE_URL = "https://metaforge.app/api/arc-raiders";

/**
 * Fetches all events from the event schedule API
 */
export const fetchEvents = () =>
  Effect.gen(function* () {
    const url = `${BASE_URL}/events-schedule`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(EventAPIResponse)),
      );
    return response.data;
  });

/**
 * Selects the best matching event: prefers currently active, else closest upcoming
 */
export const selectEvent = (
  events: readonly Event[],
  search: string,
): Event | null => {
  const normalizedSearch = normalize(search.trim());
  const byName = events.filter((e) =>
    normalize(e.name).includes(normalizedSearch),
  );
  const matches =
    byName.length > 0
      ? byName
      : events.filter((e) => normalize(e.map).includes(normalizedSearch));
  if (matches.length === 0) return null;

  const now = Date.now();
  const active = matches.find((e) => e.startTime <= now && now <= e.endTime);
  if (active) return active;

  const upcoming = matches
    .filter((e) => e.startTime > now)
    .sort((a, b) => a.startTime - b.startTime);
  return upcoming[0] ?? null;
};
