import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Option } from "effect";
import { fetchItem } from "@/data/items";
import { CommandRuntime } from "@/lib/layers";
import { parseMessageParams } from "@/lib/utils";

export const recycleTo = createBotCommand(
  "recycleto",
  async (params, { reply }) => {
    return Effect.gen(function* () {
      const search = parseMessageParams(params);
      if (!search) {
        return yield* Effect.succeed(
          reply("Please provide an item (e.g. '!recycleto sensors')"),
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

      if (Option.isNone(item.recycle_from)) {
        return yield* Effect.succeed(
          reply(`[Warn] recycle data not found for ${item.name}`),
        );
      }

      if (item.recycle_from.value.length === 0) {
        return yield* Effect.succeed(reply(`No items recycle to ${item.name}`));
      }

      const items = item.recycle_from.value.map((item) => {
        return {
          name: item.item.name,
          amount: item.quantity,
        };
      });

      return yield* Effect.succeed(
        reply(
          `These items recycle to ${item.name}: ${items.map((item) => `${item.name} (x${item.amount})`).join(", ")}`,
        ),
      );
    }).pipe(
      Effect.withLogSpan("recycle_to_command"),
      Effect.tapError((error) => Effect.logError(error.message)),
      Effect.catchAll(() =>
        Effect.succeed(reply(`[Error] Unable to fetch item data`)),
      ),
      Effect.ensureErrorType<never>(),
      CommandRuntime.runPromise,
    );
  },
);
