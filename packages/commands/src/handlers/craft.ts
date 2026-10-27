import { Effect, Option, Array as Arr } from "effect";

import { CommandError } from "../lib/command-error.js";
import { resolveItem } from "./utils.js";

export const craftHandler = Effect.fn("Command.craftHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!craft sensors')",
      );
    }

    const item = yield* resolveItem(search, { includeComponents: true });

    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (
      Option.isNone(item.value.workbench) ||
      Option.isNone(item.value.components)
    ) {
      return yield* Effect.succeed(`${item.value.name} cannot be crafted.`);
    }

    const components = Arr.join(
      Arr.map(
        item.value.components.value,
        (component) => `${component.component.name} (x${component.quantity})`,
      ),
      ", ",
    );

    return yield* Effect.succeed(
      `You must have ${item.value.workbench.value} and the following items to craft ${item.value.name}: ${components}`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
