import { fetchTraders } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import { Effect } from "effect";
import { CommandLayer } from "../lib/layers";

export const buyHandler = (query: string) =>
  Effect.gen(function* () {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!buy sensors')",
      );
    }

    const potentialId = query.toLowerCase().replace(/ /g, "-");
    const normalizedQuery = normalize(query);
    const traders = yield* fetchTraders();

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

    const lines = matches.map((m) => {
      switch (m.traderName) {
        case "Shani":
          return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} cred.`;
        case "Celeste":
          return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} seeds`;
        default:
          return `You can buy a ${m.itemName} from ${m.traderName} for ${m.price} coins`;
      }
    });

    return yield* Effect.succeed(lines.join(", "));
  }).pipe(
    Effect.withLogSpan("buy_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() =>
      Effect.succeed("[Error] Unable to fetch trader data"),
    ),
    Effect.provide(CommandLayer),
  );
