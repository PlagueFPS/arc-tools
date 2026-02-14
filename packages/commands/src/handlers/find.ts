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

    const itemById = yield* fetchItem({ id: potentialId });
    const item = itemById ?? (yield* fetchItem({ search }));
    if (!item) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (Option.isNone(item.loot_area)) {
      return yield* Effect.succeed(
        `[Warn] loot area not found for ${item.name}`,
      );
    }

    return yield* Effect.succeed(
      `${item.name} can be found in ${item.loot_area.value} areas`,
    );
  }).pipe(
    Effect.withLogSpan("find_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
