import { pipe, Effect, Option, Array as Arr } from "effect";

import { CommandError } from "../lib/command-error.js";
import { resolveItem } from "./utils.js";

export const findHandler = Effect.fn("Command.findHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!find sensors')",
      );
    }

    const item = yield* resolveItem(search, { includeComponents: true });

    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    const parts = Arr.getSomes([
      pipe(
        item.value.loot_area,
        Option.map((area) => `can be found in ${area} areas`),
      ),
      pipe(
        item.value.dropped_by,
        Option.filter(Arr.isReadonlyArrayNonEmpty),
        Option.map((enemies) =>
          pipe(
            enemies,
            Arr.map((enemy) => enemy.arc.name),
            Arr.join(", "),
            (names) => `can be dropped by ${names}`,
          ),
        ),
      ),
    ]);

    if (parts.length === 0) {
      return yield* Effect.succeed(
        `[Warn] loot area or dropped by data not found for ${item.value.name}`,
      );
    }

    return yield* Effect.succeed(
      `${item.value.name} ${Arr.join(parts, " and ")}.`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
