import { Effect, Option, Array as Arr } from "effect";

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

    const parts: string[] = [];

    if (Option.isSome(item.value.loot_area)) {
      parts.push(`can be found in ${item.value.loot_area.value} areas`);
    }

    if (
      Option.isSome(item.value.dropped_by) &&
      item.value.dropped_by.value.length > 0
    ) {
      const droppedBy = Arr.join(
        Arr.map(item.value.dropped_by.value, (e) => e.arc.name),
        ", ",
      );

      parts.push(`can be dropped by ${droppedBy}`);
    }

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
