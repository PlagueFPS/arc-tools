import { normalize } from "@arctools/utils";
import { Effect } from "effect";
import { HttpClientResponse } from "effect/unstable/http";
import { type Event, EventAPIResponse } from "./schema.js";
import { arcHttpClient } from "./utils.js";

/**
 * Fetches all events from the event schedule API
 */
export const fetchEvents = Effect.fn("ArcData.fetchEvents")(function* () {
  const httpClient = yield* arcHttpClient;
  const response = yield* httpClient
    .get("/events-schedule")
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(EventAPIResponse)));
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
