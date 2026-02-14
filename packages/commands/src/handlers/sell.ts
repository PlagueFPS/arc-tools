import { fetchItem } from "@arctools/arc-data";
import { Effect } from "effect";
import { CommandLayer } from "../lib/layers";

export const sellHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!sell sensors')",
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");

    const itemById = yield* fetchItem({ id: potentialId, minimal: true });
    const item = itemById ?? (yield* fetchItem({ search, minimal: true }));
    if (!item) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    return yield* Effect.succeed(
      `${item.name} can be sold for ${item.value} coins each`,
    );
  }).pipe(
    Effect.withLogSpan("sell_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
