import type { CommandDefinition } from "@arctools/commands";
import { ApplicationCommandOptionType } from "discord.js";

/**
 * Transforms CommandDefinition to Discord REST API payload format.
 * Maps each command's slashOptions to Discord format.
 */
export function toDiscordPayload(
  commands: readonly CommandDefinition[],
): Array<{
  name: string;
  description: string;
  options: Array<{
    type: typeof ApplicationCommandOptionType.String;
    name: string;
    description: string;
    required: boolean;
  }>;
}> {
  return commands.map(({ name, description, slashOptions }) => ({
    name,
    description,
    options: slashOptions.map((opt) => ({
      type: ApplicationCommandOptionType.String,
      name: opt.name,
      description: opt.description,
      required: opt.required ?? true,
    })),
  }));
}
