# Item and ARC lookup

Chat users request item values, crafting information, recycling output, loot locations, and ARC drops.

## Sub-features

- `buy` gives the trader and purchase price.
- `loot` lists items dropped by an ARC.
- `craft` gives ingredients and workbench or explains that crafting is unavailable.
- `find` gives loot areas.
- `sell` gives sale value.
- `recycle` gives recycling output.
- `recycleto` gives items that recycle into the requested item.

## How to get to it (user POV)

Type `!buy sensors`, `!loot bastion`, `!craft sensors`, `!find sensors`, `!sell sensors`, `!recycle sensors`, or `!recycleto sensors` in an authorized Twitch channel. In an installed Discord guild, choose the corresponding slash command. The option is `item`, except `/loot`, which uses `arc`.

## Driving it with signed HTTP and chat clients

Preconditions: working Twitch grants and enabled subscriptions, registered Discord commands, and item data. The local access baseline lacks these prerequisites.

- **Controlled integration.** Run `bun run test:cloud` from the root. The case `all ten commands execute through actual Bot routes, cache and accepted account dispatch on both transports` in `tests/cloud/tenant-cases.ts` arranges external data and signs both protocols. Require its assertions for every command, provider message observation, and replay behavior to pass. Require `result.json` test and cleanup results to be zero.
- **Exact fixture outcomes.** Buy reports `Sensors can be purchased from Shani for 100 cred.` Sell reports `Sensors can be sold for 10 coins each`. Find reports `Sensors can be found in Industrial areas.` Craft reports `Sensors cannot be crafted.` Recycle reports `No items granted for recycling Sensors`. Recycleto reports `No items recycle to Sensors`. Loot identifies Sensors in Bastion's drops.
- **Live Twitch.** Send every listed command in the configured nonproduction channel. Capture the typed command, its message identity, and the resulting threaded reply. Replaying one signed delivery must leave exactly one observed reply for the original parent.
- **Live Discord.** Submit each slash command in an installed test guild. Capture each action and public success response. Submit a missing-item query and verify its error is private using another guild member's view.

## Gotchas

- Cloud fixtures prove controlled-provider behavior. They do not establish live data accuracy, real client timing, or visibility.
- Use `item` and `arc` as exact slash option names. Twitch prefixes and Discord slash commands are separate entry points.
- Missing grants, subscriptions, registration, or source data fail the corresponding journey. Do not replace a missing input with another command and report coverage.
- The existing cloud suite also checks cold and warm cache access, missing and malformed data, duplicates, and delivery ambiguity. Preserve those assertions when adapting a journey.
