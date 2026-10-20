# Event lookup

Users ask about an event or map, current events, and events starting within two hours.

## Sub-features

- `event` searches event or map names and supports the `queen` alias.
- `upcoming` lists events in the next two hours.
- `active` lists events active now.

## How to get to it (user POV)

Send `!event queen`, `!upcoming`, or `!active` in an authorized Twitch channel. In an installed Discord guild, use `/event` with `event_or_map` set to `queen`, `/upcoming`, or `/active`.

## Driving it with signed HTTP and chat clients

Preconditions: configured grants and subscriptions for Twitch, installed slash commands for Discord, and event records with known start/end times. The local access baseline has no such seed data.

- **Controlled integration.** Run `bun run test:cloud`. Its all-ten-commands case supplies event records relative to the current time and checks exact outcomes on both signed protocols. The `queen` lookup must report `Harvester on Dam is active now (ends in 1m)`. Require the active/upcoming fixture assertions and both test and cleanup success.
- **Live event search.** Send `!event queen` and `/event event_or_map:queen`. Capture the query and returned map, event, and timing. Repeat with a map name currently present in the data source.
- **Live windows.** Send both no-argument commands on each platform. Compare results against the source schedule at the recorded request time. Active events must cover that instant. Upcoming events must fall within the two-hour window. Capture the schedule used for comparison alongside replies.

## Gotchas

- `/upcoming` and `/active` accept no options. `/event` uses `event_or_map`, not `item`.
- Time-dependent data can change between requests. Record the timestamp and source schedule for each assertion.
- A missing future or active event is an unmet precondition for a populated-results journey. Record the failure rather than claiming an empty response proves it.
- Controlled fixtures do not prove live schedule freshness.
