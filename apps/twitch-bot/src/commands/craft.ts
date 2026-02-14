import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Option } from "effect";
import { fetchItem } from "@/data/items";
import { CommandRuntime } from "@/lib/layers";
import { parseMessageParams } from "@/lib/utils";

export const craft = createBotCommand("craft", async (params, { reply }) => {
  return Effect.gen(function* () {
    const search = parseMessageParams(params);
    if (!search) {
      return yield* Effect.succeed(
        reply("Please provide an item (e.g. '!craft sensors')"),
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
      return yield* Effect.succeed(reply(`[Warn] No such item: ${search}`));
    }

    if (Option.isNone(item.workbench) || Option.isNone(item.components)) {
      return yield* Effect.succeed(reply(`${item.name} cannot be crafted.`));
    }

    const components = item.components.value
      .map(
        (component) => `${component.component.name} (x${component.quantity})`,
      )
      .join(", ");

    return yield* Effect.succeed(
      reply(
        `You must have ${item.workbench.value} and the following items to craft ${item.name}: ${components}`,
      ),
    );
  }).pipe(
    Effect.withLogSpan("craft_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() =>
      Effect.succeed(reply(`[Error] Unable to fetch item data`)),
    ),
    Effect.ensureErrorType<never>(),
    CommandRuntime.runPromise,
  );
});
