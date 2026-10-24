import { getItem, type ItemAPIParams } from "@arctools/arc-data";
import { normalize, slugify } from "@arctools/utils";
import { Effect, Option } from "effect";

/** Attempts to resolve item by id first, if none found, resolves by search query */
export const resolveItem = Effect.fnUntraced(function* (
  search: string,
  params: Omit<ItemAPIParams, "id" | "search">,
) {
  const slug = slugify(search);
  const id = slug === "bastion-cell" ? "bastion-part" : slug;

  return yield* Effect.filterOrElse(
    getItem({ ...params, id }),
    (result) => Option.isSome(result),
    () => getItem({ ...params, search: normalize(search) }),
  );
});
