import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import type { CommandArgs } from "../lib/command-args";
import { CommandError } from "../lib/command-error";

export const craftHandler = Effect.fn("Command.craftHandler")(
  function* (args: CommandArgs) {
    const search = args.search;
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!craft sensors')",
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

    if (
      Option.isNone(item.value.workbench) ||
      Option.isNone(item.value.components)
    ) {
      return yield* Effect.succeed(`${item.value.name} cannot be crafted.`);
    }

    const components = item.value.components.value
      .map(
        (component) => `${component.component.name} (x${component.quantity})`,
      )
      .join(", ");

    return yield* Effect.succeed(
      `You must have ${item.value.workbench.value} and the following items to craft ${item.value.name}: ${components}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
