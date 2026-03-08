import { getItem, type ItemAPIParams } from "@arctools/arc-data";
import { normalize, slugify } from "@arctools/utils";
import { Effect, Option } from "effect";

/** Attempts to resolve item by id first, if fails, resolves by search query */
export const resolveItem = Effect.fnUntraced(function* (
  search: string,
  params: Omit<ItemAPIParams, "id" | "search">,
) {
  return yield* Effect.filterOrElse(
    getItem({ id: slugify(search), ...params }),
    (result) => Option.isSome(result),
    () => getItem({ search: normalize(search), ...params }),
  );
});
