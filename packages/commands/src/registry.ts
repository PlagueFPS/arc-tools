import type { Effect } from "effect";
import { activeHandler } from "./handlers/active";
import { craftHandler } from "./handlers/craft";
import { eventHandler } from "./handlers/event";
import { findHandler } from "./handlers/find";
import { recycleHandler } from "./handlers/recycle";
import { recycleToHandler } from "./handlers/recycle-to";
import { sellHandler } from "./handlers/sell";
import { upcomingHandler } from "./handlers/upcoming";

export interface SlashOption {
  name: string;
  description: string;
  type: "string";
  required?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  slashOptions: SlashOption[];
  handler: (search: string) => Effect.Effect<string, never, never>;
}

const ITEM_OPTION: SlashOption = {
  name: "item",
  description: "Item name",
  type: "string",
  required: true,
};

export const commands: readonly CommandDefinition[] = [
  {
    name: "craft",
    description: "Get the required items and workbench to craft an item.",
    usage: "!craft <item>",
    slashOptions: [ITEM_OPTION],
    handler: craftHandler,
  },
  {
    name: "find",
    description: "Get the loot areas where an item can be found.",
    usage: "!find <item>",
    slashOptions: [ITEM_OPTION],
    handler: findHandler,
  },
  {
    name: "sell",
    description: "Get the sell value of an item.",
    usage: "!sell <item>",
    slashOptions: [ITEM_OPTION],
    handler: sellHandler,
  },
  {
    name: "recycle",
    description: "Get the items granted for recycling an item.",
    usage: "!recycle <item>",
    slashOptions: [ITEM_OPTION],
    handler: recycleHandler,
  },
  {
    name: "recycleto",
    description: "Get all items that recycle into a specific item.",
    usage: "!recycleto <item>",
    slashOptions: [ITEM_OPTION],
    handler: recycleToHandler,
  },
  {
    name: "event",
    description:
      "Get currently active or upcoming events by event or map name.",
    usage: "!event <event or map>",
    slashOptions: [
      {
        name: "event_or_map",
        description: "Event or map name",
        type: "string",
        required: true,
      },
    ],
    handler: eventHandler,
  },
  {
    name: "upcoming",
    description: "Display all upcoming events within the next 2 hours.",
    usage: "!upcoming",
    slashOptions: [],
    handler: upcomingHandler,
  },
  {
    name: "active",
    description: "Display all currently active events.",
    usage: "!active",
    slashOptions: [],
    handler: activeHandler,
  },
];
