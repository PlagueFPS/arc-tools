import { createBotCommand } from "@twurple/easy-bot";
import { Effect } from "effect";
import { fetchItem } from "@/data/items";
import { CommandRuntime } from "@/lib/layers";
import { parseMessageParams } from "@/lib/utils";

export const sell = createBotCommand("sell", async (params, { reply }) => {
  return Effect.gen(function* () {
    const search = parseMessageParams(params);
    if (!search) {
      return yield* Effect.succeed(
        reply("Please provide an item (e.g. '!sell sensors')"),
      );
    }

    const potentialId = search.toLowerCase().replace(/ /g, "-");

    const itemById = yield* fetchItem({ id: potentialId, minimal: true });
    const item = itemById ?? (yield* fetchItem({ search, minimal: true }));
    if (!item) {
      return yield* Effect.succeed(reply(`[Warn] No such item: ${search}`));
    }

    return yield* Effect.succeed(
      reply(`${item.name} can be sold for ${item.value} coins each`),
    );
  }).pipe(
    Effect.withLogSpan("sell_command"),
    Effect.tapError(Effect.logError),
    Effect.catchAll(() =>
      Effect.succeed(reply(`[Error] Unable to fetch item data`)),
    ),
    Effect.ensureErrorType<never>(),
    CommandRuntime.runPromise,
  );
});
