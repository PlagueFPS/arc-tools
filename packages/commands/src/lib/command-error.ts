import { DataUnavailable } from "@arctools/arc-data";
import { Schema } from "effect";

export class CommandError extends Schema.TaggedError<
  CommandError,
  { readonly brand: unique symbol }
>()("CommandError", {
  cause: Schema.Unknown,
  stale: Schema.optional(Schema.Boolean),
}) {
  get message() {
    const message = Schema.is(DataUnavailable)(this.cause)
      ? this.cause.message
      : "Something went wrong while executing your command!";

    return this.stale ? `${message} [Using cached data]` : message;
  }
}
