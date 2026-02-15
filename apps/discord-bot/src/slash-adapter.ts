import type { CommandDefinition } from "@arctools/commands";
import { ApplicationCommandOptionType } from "discord.js";

export const SLASH_OPTION_NAME = "query" as const;

const QUERY_OPTION = {
  type: ApplicationCommandOptionType.String as const,
  name: SLASH_OPTION_NAME,
  description: "Search term (e.g. item, map, event)",
  required: true,
};

/**
 * Transforms CommandDefinition to Discord REST API payload format.
 * Strips handler and adds the required string option for the search parameter.
 */
export function toDiscordPayload(
  commands: readonly CommandDefinition[],
): Array<{
  name: string;
  description: string;
  options: (typeof QUERY_OPTION)[];
}> {
  return commands.map(({ name, description }) => ({
    name,
    description,
    options: [QUERY_OPTION],
  }));
}

