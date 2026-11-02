import {
  Array as Arr,
  Context,
  type Effect,
  pipe,
  Schema,
  String as Str,
} from "effect";

export const SuggestionKind = Schema.Literals(["items", "arcs", "events-maps"]);

export type SuggestionKind = typeof SuggestionKind.Type;

export const Suggestion = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

export type Suggestion = typeof Suggestion.Type;

export class Suggestions extends Context.Service<
  Suggestions,
  {
    readonly suggest: (
      kind: SuggestionKind,
      query: string,
    ) => Effect.Effect<readonly Suggestion[]>;
  }
>()("@arctools/Suggestions") {}

export const Catalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ name: Schema.String })),
});

export const rankSuggestions = (
  names: readonly string[],
  query: string,
): readonly Suggestion[] => {
  const normalized = pipe(query, Str.trim, Str.toLowerCase);

  if (!normalized) return [];

  const score = (name: string) => {
    const lower = Str.toLowerCase(name);

    if (lower === normalized) return 0;

    return Str.startsWith(normalized)(lower) ? 1 : 2;
  };

  return pipe(
    names,
    Arr.dedupe,
    Arr.filter(
      (name) =>
        name.length > 0 &&
        name.length <= 100 &&
        Str.includes(normalized)(Str.toLowerCase(name)),
    ),
    Arr.sort((a: string, b: string) => {
      const priority = score(a) - score(b);

      if (priority) return priority < 0 ? -1 : 1;
      const lowerA = Str.toLowerCase(a);
      const lowerB = Str.toLowerCase(b);

      if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;

      return a < b ? -1 : a > b ? 1 : 0;
    }),
    Arr.take(25),
    Arr.map((name) => ({ name, value: name })),
  );
};
