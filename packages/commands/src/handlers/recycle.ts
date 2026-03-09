import { sortByDesc } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error.js";
import { resolveItem } from "./utils.js";

export const recycleHandler = Effect.fn("Command.recycleHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycle sensors')",
      );
    }

    const item = yield* resolveItem(search, { includeComponents: true });
    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (Option.isNone(item.value.recycle_components)) {
      return yield* Effect.succeed(
        `[Warn] recycle data not found for ${item.value.name}`,
      );
    }

    if (item.value.recycle_components.value.length === 0) {
      return yield* Effect.succeed(
        `No items granted for recycling ${item.value.name}`,
      );
    }

    const items = sortByDesc(
      item.value.recycle_components.value,
      (i) => i.quantity,
    )
      .map((entry) => `${entry.component.name} (x${entry.quantity})`)
      .join(", ");

    return yield* Effect.succeed(
      `These items are granted for recycling ${item.value.name}: ${items}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
