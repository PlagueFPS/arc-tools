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
    description: "Get the required items and workbench to craft an item.",
    usage: "!craft <item>",
    handler: craftHandler,
  },
  {
    name: "find",
    description: "Get the loot areas where an item can be found.",
    usage: "!find <item>",
    handler: findHandler,
  },
  {
    name: "sell",
    description: "Get the sell value of an item.",
    usage: "!sell <item>",
    handler: sellHandler,
  },
  {
    name: "recycle",
    description: "Get the items granted for recycling an item.",
    usage: "!recycle <item>",
    handler: recycleHandler,
  },
  {
    name: "recycleto",
    description: "Get all items that recycle into a specific item.",
    usage: "!recycleto <item>",
    handler: recycleToHandler,
  },
  {
    name: "event",
    description:
      "Get currently active or upcoming events by event or map name.",
    usage: "!event <event or map>",
    handler: eventHandler,
  },
];
