import { fetchItem } from "@arctools/arc-data";
import { sortByDesc } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandLayer } from "../lib/layers";

export const recycleToHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycleto sensors')",
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");

    const itemById = yield* fetchItem({
      id: potentialId,
      includeComponents: true,
    });
    const item =
      itemById ?? (yield* fetchItem({ search, includeComponents: true }));
    if (!item) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (Option.isNone(item.recycle_from)) {
      return yield* Effect.succeed(
        `[Warn] recycle data not found for ${item.name}`,
      );
    }

    if (item.recycle_from.value.length === 0) {
      return yield* Effect.succeed(`No items recycle to ${item.name}`);
    }

    const items = item.recycle_from.value.map((entry) => ({
      name: entry.item.name,
      amount: entry.quantity,
    }));

    const formattedItems = sortByDesc(items, (i) => i.amount)
      .map((i) => `${i.name} (x${i.amount})`)
      .join(", ");

    return yield* Effect.succeed(
      `These items recycle to ${item.name}: ${formattedItems}`,
    );
  }).pipe(
    Effect.withLogSpan("recycle_to_command"),
    Effect.tapError((error) => Effect.logError(error.message)),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
