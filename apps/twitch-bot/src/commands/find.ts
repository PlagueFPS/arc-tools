import { HttpClient, HttpClientResponse } from "@effect/platform";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect, Option } from "effect";
import { ItemAPIResponse } from "@/data/schema";
import { CommandRuntime } from "@/lib/layers";

export const find = createBotCommand("find", async (params, { reply }) => {
  return Effect.gen(function* () {
    const search = params
      .map((param) => param.trim())
      .filter(Boolean)
      .join(" ");

    if (!search) {
      return yield* Effect.succeed(
        reply("Please provide an item (e.g. '!find sensors')"),
      );
    }

    const searchParams = new URLSearchParams({
      search,
    });
    const url = `https://metaforge.app/api/arc-raiders/items?${searchParams.toString()}`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemAPIResponse)));

    const item = response.data[0];
    if (!item)
      return yield* Effect.succeed(reply(`[Warn] No such item: ${search}`));
    if (Option.isNone(item.loot_area))
      return yield* Effect.succeed(
        reply(`[Warn] loot area not found for ${item.name}`),
      );

    return yield* Effect.succeed(
      reply(`${item.name} can be found in ${item.loot_area.value} areas`),
    );
  }).pipe(
    Effect.withLogSpan("find_command"),
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
});
