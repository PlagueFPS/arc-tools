import { fetchArc } from "@arctools/arc-data";
import { normalize } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";

export const lootHandler = Effect.fn("Command.lootHandler")(
  function* (query: string) {
    if (!query) {
      return yield* Effect.succeed(
        "Please provide an arc name (e.g. '!loot bastion')",
      );
    }

    const potentialId = query.toLowerCase().replace(/ /g, "-");
    const arc = yield* Effect.filterOrElse(
      fetchArc({ id: potentialId }),
      (result) => Option.isSome(result),
      () => fetchArc({ search: normalize(query) }),
    );

    if (Option.isNone(arc))
      return yield* Effect.succeed(`[Warn] No such arc: ${query}`);

    if (Option.isNone(arc.value.loot)) {
      return yield* Effect.succeed(
        `[Warn] loot data not found for ${arc.value.name}`,
      );
    }

    if (arc.value.loot.value.length === 0) {
      return yield* Effect.succeed(`No loot found for ${arc.value.name}`);
    }

    const lootItems = arc.value.loot.value
      .map((value) => value.item.name)
      .join(", ");

    return yield* Effect.succeed(
      `${arc.value.name}s drop the following items: ${lootItems}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
