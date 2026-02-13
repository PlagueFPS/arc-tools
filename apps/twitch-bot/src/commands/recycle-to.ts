import { HttpClient, HttpClientResponse } from "@effect/platform";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Option } from "effect";
import { ItemAPIResponse } from "@/data/schema";
import { CommandRuntime } from "@/lib/layers";

export const recycleTo = createBotCommand(
  "recycleto",
  async (params, { reply }) => {
    return Effect.gen(function* () {
      const search = params
        .map((param) => param.trim())
        .filter(Boolean)
        .join(" ");
      if (!search) {
        return yield* Effect.succeed(
          reply("Please provide an item (e.g. '!recycleto sensors')"),
        );
      }

      const searchParams = new URLSearchParams({
        includeComponents: "true",
        search,
      });
      const url = `https://metaforge.app/api/arc-raiders/items?${searchParams.toString()}`;
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient
        .get(url)
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemAPIResponse)),
        );

      const item = response.data[0];
      if (!item)
        return yield* Effect.succeed(reply(`[Warn] No such item: ${search}`));
      if (Option.isNone(item.recycle_from))
        return yield* Effect.succeed(
          reply(`[Warn] recycle data not found for ${item.name}`),
        );

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
      Effect.tapError(Effect.logError),
      Effect.catchTags({
        RequestError: () =>
          Effect.succeed(reply(`[Error] Unable to fetch item data`)),
        ResponseError: () =>
          Effect.succeed(reply(`[Error] Unable to parse response`)),
        ParseError: () =>
          Effect.succeed(reply(`[Error] Unable to parse response`)),
      }),
      Effect.ensureErrorType<never>(),
      CommandRuntime.runPromise,
    );
  },
);
