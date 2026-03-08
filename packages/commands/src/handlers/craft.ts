import { getItem } from "@arctools/arc-data";
import { normalize, slugify } from "@arctools/utils";
import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error";

export const craftHandler = Effect.fn("Command.craftHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!craft sensors')",
      );
    }

    const item = yield* Effect.filterOrElse(
      getItem({ id: slugify(search), includeComponents: true }),
      (result) => Option.isSome(result),
      () => getItem({ search: normalize(search), includeComponents: true }),
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
