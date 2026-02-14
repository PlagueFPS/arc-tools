import { commands } from "@arctools/commands";
import { parseMessageParams } from "@arctools/utils";
import { createBotCommand } from "@twurple/easy-bot";
import { Effect } from "effect";

const twitchCommands = commands.map((def) =>
  createBotCommand(def.name, async (params, { reply }) => {
    const search = parseMessageParams(params);
    const result = await Effect.runPromise(def.handler(search));
    return reply(result);
  }),
);

export { twitchCommands };
