import type { ArcData } from "@arctools/arc-data";
import type { Effect } from "effect";

import type { CommandName } from "./catalog.js";
import { activeHandler } from "./handlers/active.js";
import { buyHandler } from "./handlers/buy.js";
import { craftHandler } from "./handlers/craft.js";
import { eventHandler } from "./handlers/event.js";
import { findHandler } from "./handlers/find.js";
import { lootHandler } from "./handlers/loot.js";
import { recycleToHandler } from "./handlers/recycle-to.js";
import { recycleHandler } from "./handlers/recycle.js";
import { sellHandler } from "./handlers/sell.js";
import { upcomingHandler } from "./handlers/upcoming.js";
import type { CommandError } from "./lib/command-error.js";

export type CommandHandler = (
  input: string,
) => Effect.Effect<string, CommandError, ArcData>;

export const commandHandlers = {
  buy: buyHandler,
  loot: lootHandler,
  craft: craftHandler,
  find: findHandler,
  sell: sellHandler,
  recycle: recycleHandler,
  recycleto: recycleToHandler,
  event: eventHandler,
  upcoming: upcomingHandler,
  active: activeHandler,
} satisfies Record<CommandName, CommandHandler>;
