import { Schema } from "effect";

export class CommandError extends Schema.TaggedErrorClass<CommandError>()(
  "CommandError",
  {
    cause: Schema.Unknown,
  },
) {
  static message = "Something went wrong while executing your command!";
}
