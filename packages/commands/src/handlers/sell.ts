import { Effect, Option } from "effect";
import { CommandError } from "../lib/command-error.js";
import { resolveItem } from "./utils.js";

export const sellHandler = Effect.fn("Command.sellHandler")(
  function* (search: string) {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!sell sensors')",
      );
    }

    const item = yield* resolveItem(search, { minimal: true });
    if (Option.isNone(item)) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    return yield* Effect.succeed(
      `${item.value.name} can be sold for ${item.value.value} coins each`,
    );
  },
  (self) => Effect.mapError(self, (cause) => new CommandError({ cause })),
);
