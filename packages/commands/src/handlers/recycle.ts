import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";
import { CommandLayer } from "../lib/layers";

export const recycleHandler = Effect.fn("Command.recycleHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!recycle sensors')",
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

    if (Option.isNone(item.value.recycle_components)) {
      return yield* Effect.succeed(
        `[Warn] recycle data not found for ${item.value.name}`,
      );
    }

    if (item.value.recycle_components.value.length === 0) {
      return yield* Effect.succeed(
        `No items granted for recycling ${item.value.name}`,
      );
    }

    const items = item.value.recycle_components.value.map((entry) => ({
      name: entry.component.name,
      amount: entry.quantity,
    }));

    return yield* Effect.succeed(
      `These items are granted for recycling ${item.value.name}: ${items.map((i) => `${i.name} (x${i.amount})`).join(", ")}`,
    );
  },
  (self) =>
    Effect.mapError(self, (cause) => new CommandError({ cause })).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.catch((error) => Effect.succeed(error.message)),
      Effect.provide(CommandLayer),
    ),
);
