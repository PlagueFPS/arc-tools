import { getTraders } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import { Effect, Array as Arr, Record as Rec, String as Str } from "effect";

import { CommandError } from "../lib/command-error.js";

export const buyHandler = Effect.fn("Command.buyHandler")(
  function* (query: string) {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!buy sensors')",
      );
    }

    const potentialId = Str.replace(/ /g, "-")(Str.toLowerCase(query));

    const normalizedQuery = normalize(query);
    const traders = yield* getTraders();

    const matches: { traderName: string; itemName: string; price: number }[] =
      [];

    for (const [traderName, inventory] of Rec.toEntries(traders)) {
      Arr.forEach(inventory, (item) => {
        const matchesId = Str.toLowerCase(item.id) === potentialId;

        const matchesName =
          Str.includes(Str.toLowerCase(query))(Str.toLowerCase(item.name)) ||
          Str.includes(normalizedQuery)(normalize(item.name));

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

    const response = Arr.join(
      Arr.map(matches, (m) => {
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
