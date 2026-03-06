import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";
import { CommandLayer } from "../lib/layers";

export const sellHandler = Effect.fn("Command.sellHandler")(
  function* (search: string) {
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
  (self) =>
    Effect.mapError(self, (cause) => new CommandError({ cause })).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.catch((error) => Effect.succeed(error.message)),
      Effect.provide(CommandLayer),
    ),
);
