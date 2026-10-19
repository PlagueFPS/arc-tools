export {
  CommandExecution,
  CommandName,
  type CommandReply,
  executeCommand,
} from "./execute.js";
export { CommandError } from "./lib/command-error.js";
export {
  type CommandDefinition,
  commands,
  type SlashOption,
} from "./registry.js";
