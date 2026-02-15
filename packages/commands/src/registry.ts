import type { Effect } from "effect";
import { craftHandler } from "./handlers/craft.js";
import { eventHandler } from "./handlers/event.js";
import { findHandler } from "./handlers/find.js";
import { recycleHandler } from "./handlers/recycle.js";
import { recycleToHandler } from "./handlers/recycle-to.js";
import { sellHandler } from "./handlers/sell.js";

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: (search: string) => Effect.Effect<string, never, never>;
}

export const commands: readonly CommandDefinition[] = [
  {
    name: "craft",
    description: "Get crafting recipe for an item",
    usage: "!craft <item>",
    handler: craftHandler,
  },
  {
    name: "find",
    description: "Find loot areas for an item",
    usage: "!find <item>",
    handler: findHandler,
  },
  {
    name: "sell",
    description: "Get sell value for an item",
    usage: "!sell <item>",
    handler: sellHandler,
  },
  {
    name: "recycle",
    description: "Get items granted when recycling an item",
    usage: "!recycle <item>",
    handler: recycleHandler,
  },
  {
    name: "recycleto",
    description: "Get items that recycle into an item",
    usage: "!recycleto <item>",
    handler: recycleToHandler,
  },
  {
    name: "event",
    description: "Look up event schedule by event or map name",
    usage: "!event <event or map>",
    handler: eventHandler,
  },
];
