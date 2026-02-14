import { fetchItem } from "@arctools/arc-data";
import { Effect, Option } from "effect";
import { CommandLayer } from "../lib/layers";

export const craftHandler = (search: string) =>
  Effect.gen(function* () {
    if (!search) {
      return yield* Effect.succeed(
        "Please provide an item (e.g. '!craft sensors')",
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");

    const itemById = yield* fetchItem({
      id: potentialId,
      includeComponents: true,
    });
    const item =
      itemById ?? (yield* fetchItem({ search, includeComponents: true }));

    if (!item) {
      return yield* Effect.succeed(`[Warn] No such item: ${search}`);
    }

    if (Option.isNone(item.workbench) || Option.isNone(item.components)) {
      return yield* Effect.succeed(`${item.name} cannot be crafted.`);
    }

    const components = item.components.value
      .map(
        (component) => `${component.component.name} (x${component.quantity})`,
      )
      .join(", ");

    return yield* Effect.succeed(
      `You must have ${item.workbench.value} and the following items to craft ${item.name}: ${components}`,
    );
  }).pipe(
    Effect.withLogSpan("craft_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() => Effect.succeed("[Error] Unable to fetch item data")),
    Effect.provide(CommandLayer),
  );
