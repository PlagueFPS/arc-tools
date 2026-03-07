import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import type { CommandArgs } from "../lib/command-args";
import { CommandError } from "../lib/command-error";

export const sellHandler = Effect.fn("Command.sellHandler")(
  function* (args: CommandArgs) {
    const search = args.search;
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!sell sensors')",
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");

    const item = yield* Effect.filterOrElse(
      fetchItem({ id: potentialId, minimal: true }),
      (result) => Option.isSome(result),
      () => fetchItem({ search, minimal: true }),
    );

    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    return yield* Effect.succeed(
      `${item.value.name} can be sold for ${item.value.value} coins each`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
