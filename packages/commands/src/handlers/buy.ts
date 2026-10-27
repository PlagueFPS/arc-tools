import { getTraders } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import {
  Effect,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";

import { CommandError } from "../lib/command-error.js";

export const buyHandler = Effect.fn("Command.buyHandler")(
  function* (query: string) {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!buy sensors')",
      );
    }

    const potentialId = EffectString.replace(
      / /g,
      "-",
    )(EffectString.toLowerCase(query));

    const normalizedQuery = normalize(query);
    const traders = yield* getTraders();

    const matches: { traderName: string; itemName: string; price: number }[] =
      [];

    for (const [traderName, inventory] of EffectRecord.toEntries(traders)) {
      EffectArray.forEach(inventory, (item) => {
        const matchesId = EffectString.toLowerCase(item.id) === potentialId;

        const matchesName =
          EffectString.includes(EffectString.toLowerCase(query))(
            EffectString.toLowerCase(item.name),
          ) || EffectString.includes(normalizedQuery)(normalize(item.name));

        if (matchesId || matchesName) {
          matches.push({
            traderName,
            itemName: item.name,
            price: item.trader_price,
          });
        }
      });
    }

    if (matches.length === 0) {
      return yield* Effect.succeed(`[Warn] No trader sells: ${query}`);
    }

    const response = EffectArray.join(
      EffectArray.map(matches, (m) => {
        switch (m.traderName) {
          case "Shani":
            return `${m.itemName} can be purchased from ${m.traderName} for ${m.price} cred.`;
          case "Celeste":
            return `${m.itemName} can be purchased from ${m.traderName} for ${m.price} seeds`;
          default:
            return `${m.itemName} can be purchased from ${m.traderName} for ${m.price} coins`;
        }
      }),
      ", ",
    );

    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
