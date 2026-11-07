import { getTraders } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import {
  pipe,
  Effect,
  Match,
  Array as Arr,
  Record as Rec,
  String as Str,
} from "effect";

import { CommandError } from "../lib/command-error.js";

export const buyHandler = Effect.fn("Command.buyHandler")(
  function* (query: string) {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!buy sensors')",
      );
    }

    const potentialId = pipe(query, Str.toLowerCase, Str.replace(/ /g, "-"));

    const normalizedQuery = normalize(query);
    const traders = yield* getTraders();

    const matches = pipe(
      traders,
      Rec.toEntries,
      Arr.flatMap(([traderName, inventory]) =>
        pipe(
          inventory,
          Arr.filter((item) => {
            const matchesId = Str.toLowerCase(item.id) === potentialId;

            const matchesName =
              pipe(
                item.name,
                Str.toLowerCase,
                Str.includes(Str.toLowerCase(query)),
              ) || pipe(item.name, normalize, Str.includes(normalizedQuery));

            return matchesId || matchesName;
          }),
          Arr.map((item) => ({
            traderName,
            itemName: item.name,
            price: item.trader_price,
          })),
        ),
      ),
    );

    if (matches.length === 0) {
      return yield* Effect.succeed(`[Warn] No trader sells: ${query}`);
    }

    const response = pipe(
      matches,
      Arr.map((m) => {
        return Match.value(m.traderName).pipe(
          Match.when(
            "Shani",
            () =>
              `${m.itemName} can be purchased from ${m.traderName} for ${m.price} cred.`,
          ),
          Match.when(
            "Celeste",
            () =>
              `${m.itemName} can be purchased from ${m.traderName} for ${m.price} seeds`,
          ),
          Match.orElse(
            () =>
              `${m.itemName} can be purchased from ${m.traderName} for ${m.price} coins`,
          ),
        );
      }),
      Arr.join(", "),
    );

    return yield* Effect.succeed(response);
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
