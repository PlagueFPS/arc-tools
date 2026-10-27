import { Schema } from "effect";

export class FixtureInvariantError extends Schema.TaggedError<
  FixtureInvariantError,
  { readonly brand: unique symbol }
>()("FixtureInvariantError", { message: Schema.String }) {}
