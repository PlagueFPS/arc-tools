import { Schema } from "effect";

import { commandCatalog } from "./catalog.js";

export const CommandName = Schema.Literals(
  commandCatalog.map((command) => command.name),
);

export const CommandExecution = Schema.Struct({
  command: CommandName,
  input: Schema.String.check(Schema.isMaxLength(256)),
  deadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CommandExecution = typeof CommandExecution.Type;
