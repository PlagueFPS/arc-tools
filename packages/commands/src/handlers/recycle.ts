import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandLayer } from "../lib/layers";

export const recycleHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycle sensors')",
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

    if (Option.isNone(item.recycle_components)) {
      return yield* Effect.succeed(
        `[Warn] recycle data not found for ${item.name}`,
      );
    }

    if (item.recycle_components.value.length === 0) {
      return yield* Effect.succeed(
        `No items granted for recycling ${item.name}`,
      );
    }

    const items = item.recycle_components.value.map((entry) => ({
      name: entry.component.name,
      amount: entry.quantity,
    }));

    return yield* Effect.succeed(
      `These items are granted for recycling ${item.name}: ${items.map((i) => `${i.name} (x${i.amount})`).join(", ")}`,
    );
  }).pipe(
    Effect.withLogSpan("recycle_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
