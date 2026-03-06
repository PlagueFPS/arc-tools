import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";
import { CommandLayer } from "../lib/layers";

export const findHandler = Effect.fn("Command.findHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!find sensors')",
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

    const parts: string[] = [];
    if (Option.isSome(item.value.loot_area)) {
      parts.push(`can be found in ${item.value.loot_area.value} areas`);
    }

    if (
      Option.isSome(item.value.dropped_by) &&
      item.value.dropped_by.value.length > 0
    ) {
      const droppedBy = item.value.dropped_by.value
        .map((e) => e.arc.name)
        .join(", ");
      parts.push(`can be dropped by ${droppedBy}`);
    }

    if (parts.length === 0) {
      return yield* Effect.succeed(
        `[Warn] loot area or dropped by data not found for ${item.value.name}`,
      );
    }

    return yield* Effect.succeed(`${item.value.name} ${parts.join(" and ")}.`);
  },
  (self) =>
    Effect.mapError(self, (cause) => new CommandError({ cause })).pipe(
      Effect.provide(CommandLayer),
    ),
);
