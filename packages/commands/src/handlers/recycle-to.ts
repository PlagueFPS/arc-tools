import { fetchItem } from "@arctools/arc-data";
import { normalize, slugify, sortByDesc } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";

export const recycleToHandler = Effect.fn("Command.recycleToHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycleto sensors')",
      );
    }

    const item = yield* Effect.filterOrElse(
      fetchItem({ id: slugify(search), includeComponents: true }),
      (result) => Option.isSome(result),
      () => fetchItem({ search: normalize(search), includeComponents: true }),
    );

    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (Option.isNone(item.value.recycle_from)) {
      return yield* Effect.succeed(
        `[Warn] recycle data not found for ${item.value.name}`,
      );
    }

    if (item.value.recycle_from.value.length === 0) {
      return yield* Effect.succeed(`No items recycle to ${item.value.name}`);
    }

    const items = sortByDesc(item.value.recycle_from.value, (i) => i.quantity)
      .map((entry) => `${entry.item.name} (x${entry.quantity})`)
      .join(", ");

    return yield* Effect.succeed(
      `These items recycle to ${item.value.name}: ${items}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
