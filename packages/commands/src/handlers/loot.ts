import { fetchArc } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandLayer } from "../lib/layers";

export const lootHandler = (query: string) =>
  Effect.gen(function* () {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an arc name (e.g. '!loot bastion')",
      );
    }

    const normalizedQuery = normalize(query.trim());
    const arcById = yield* fetchArc({ id: normalizedQuery });
    const arc = arcById ?? (yield* fetchArc({ search: normalizedQuery }));
    if (!arc) return yield* Effect.succeed(`[Warn] No such arc: ${query}`);

    if (Option.isNone(arc.loot)) {
      return yield* Effect.succeed(
        `[Warn] loot data not found for ${arc.name}`,
      );
    }

    if (arc.loot.value.length === 0) {
      return yield* Effect.succeed(`No loot found for ${arc.name}`);
    }

    const lootItems = arc.loot.value.map((value) => value.item.name).join(", ");

    return yield* Effect.succeed(
      `${arc.name}s drop the following items: ${lootItems}`,
    );
  }).pipe(
    Effect.withLogSpan("loot_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch arc data")),
    Effect.provide(CommandLayer),
  );
