import { DataUnavailable } from "@arctools/arc-data";
import { Schema } from "effect";

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    cause: Schema.Unknown,
    stale: Schema.optional(Schema.Boolean),
  },
) {
  get message() {
    const message =
      this.cause instanceof DataUnavailable
        ? this.cause.message
        : "Something went wrong while executing your command!";
    return this.stale ? `${message} [Using cached data]` : message;
  }
}
