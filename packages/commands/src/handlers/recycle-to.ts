import { fetchItem } from "@arctools/arc-data";
import { sortByDesc } from "@arctools/utils";
import { Effect, Option } from "effect";
import type { CommandArgs } from "../lib/command-args";
import { CommandError } from "../lib/command-error";

export const recycleToHandler = Effect.fn("Command.recycleToHandler")(
  function* (args: CommandArgs) {
    const search = args.search;
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycleto sensors')",
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");
    const item = yield* Effect.filterOrElse(
      fetchItem({ id: potentialId, includeComponents: true }),
      (result) => Option.isSome(result),
      () => fetchItem({ search, includeComponents: true }),
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

    const items = item.value.recycle_from.value.map((entry) => ({
      name: entry.item.name,
      amount: entry.quantity,
    }));

    const formattedItems = sortByDesc(items, (i) => i.amount)
      .map((i) => `${i.name} (x${i.amount})`)
      .join(", ");

    return yield* Effect.succeed(
      `These items recycle to ${item.value.name}: ${formattedItems}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
