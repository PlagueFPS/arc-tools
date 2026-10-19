import { normalize } from "@arctools/utils";
import { Array as Arr, Clock, Effect, Option } from "effect";

import { ArcData } from "./data-service.js";
import type { Event } from "./schema.js";

/**
 * Gets all events from the event schedule API
 */
export const getEvents = Effect.fn("ArcData.getEvents")(function* () {
  const data = yield* ArcData;
  return (yield* data.events()).value;
});

/**
 * Selects the best matching event: prefers currently active, else closest upcoming
 */
export const selectEvent = Effect.fn("ArcData.selectEvent")(function* (
  events: readonly Event[],
  search: string,
) {
  const normalizedSearch = normalize(search);
  const eventsByName = Arr.filter(events, (e) =>
    normalize(e.name).includes(normalizedSearch),
  );
  if (eventsByName.length === 0) return Option.none();

  const now = yield* Clock.currentTimeMillis;
  const activeEvent = Arr.findFirst(
    eventsByName,
    (e) => e.startTime <= now && now < e.endTime,
  );
  if (Option.isNone(activeEvent)) {
    const upcoming = Arr.filter(eventsByName, (e) => e.startTime > now).sort(
      (a, b) => a.startTime - b.startTime,
    );
    return Arr.head(upcoming);
  }

  return activeEvent;
});
