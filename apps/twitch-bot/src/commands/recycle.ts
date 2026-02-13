import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Option } from "effect";
import { CommandRuntime } from "@/lib/layers";
import { fetchItem, parseMessageParams } from "@/lib/utils";

export const recycle = createBotCommand(
  "recycle",
  async (params, { reply }) => {
    return Effect.gen(function* () {
      const search = parseMessageParams(params);
      if (!search) {
        return yield* Effect.succeed(
          reply("Please provide an item (e.g. '!recycle sensors')"),
        );
      }

      const item = yield* fetchItem({ search, includeComponents: "true" });
      if (!item) {
        return yield* Effect.succeed(reply(`[Warn] No such item: ${search}`));
      }

      if (Option.isNone(item.recycle_components)) {
        return yield* Effect.succeed(
          reply(`[Warn] recycle data not found for ${item.name}`),
        );
      }

      if (item.recycle_components.value.length === 0) {
        return yield* Effect.succeed(
          reply(`No items granted for recycling ${item.name}`),
        );
      }

      const items = item.recycle_components.value.map((item) => {
        return {
          name: item.component.name,
          amount: item.quantity,
        };
      });

      return yield* Effect.succeed(
        reply(
          `These items are granted for recycling ${item.name}: ${items.map((item) => `${item.name} (x${item.amount})`).join(", ")}`,
        ),
      );
    }).pipe(
      Effect.withLogSpan("recycle_command"),
      Effect.tapError(Effect.logError),
      Effect.catchAll(() =>
        Effect.succeed(reply(`[Error] Unable to fetch item data`)),
      ),
      Effect.ensureErrorType<never>(),
      CommandRuntime.runPromise,
    );
  },
);
