import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandLayer } from "../lib/layers";

export const findHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!find sensors')",
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

    const parts: string[] = [];
    if (Option.isSome(item.loot_area)) {
      parts.push(`can be found in ${item.loot_area.value} areas`);
    }

    if (Option.isSome(item.dropped_by) && item.dropped_by.value.length > 0) {
      const droppedBy = item.dropped_by.value.map((e) => e.arc.name).join(", ");
      parts.push(`can be dropped by ${droppedBy}`);
    }

    if (parts.length === 0) {
      return yield* Effect.succeed(
        `[Warn] loot area or dropped by data not found for ${item.name}`,
      );
    }

    return yield* Effect.succeed(`${item.name} ${parts.join(" and ")}.`);
  }).pipe(
    Effect.withLogSpan("find_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
