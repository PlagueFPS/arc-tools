import { getTraders } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import { Effect } from "effect";
import { CommandError } from "../lib/command-error.js";

export const buyHandler = Effect.fn("Command.buyHandler")(
  function* (query: string) {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!buy sensors')",
      );
    }

    const potentialId = query.toLowerCase().replace(/ /g, "-");
    const normalizedQuery = normalize(query);
    const traders = yield* getTraders();

    const matches: { traderName: string; itemName: string; price: number }[] =
      [];

    for (const [traderName, inventory] of Object.entries(traders)) {
      inventory.forEach((item) => {
        const matchesId = item.id.toLowerCase() === potentialId;
        const matchesName =
          item.name.toLowerCase().includes(query.toLowerCase()) ||
          normalize(item.name).includes(normalizedQuery);

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

    const response = matches
      .map((m) => {
        switch (m.traderName) {
          case "Shani":
            return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} cred.`;
          case "Celeste":
            return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} seeds`;
          default:
            return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} coins`;
        }
      })
      .join(", ");

    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
