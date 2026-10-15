import { Schema } from "effect";

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    cause: Schema.Unknown,
  },
) {
  get message() {
    return "Something went wrong while executing your command!";
  }
}
