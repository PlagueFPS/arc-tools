import { commandCatalog, type CommandName } from "@arctools/commands/catalog";
import { Array as Arr, Schema, String as Str } from "effect";

export const Category = Schema.Literals(["All", "Items", "Workshop", "Events"]);

export type Category = typeof Category.Type;

export const categoryLayout = {
  All: { left: 4, width: 46 },
  Items: { left: 52, width: 58 },
  Workshop: { left: 112, width: 90 },
  Events: { left: 204, width: 68 },
} satisfies Record<Category, { left: number; width: number }>;

export const categoryFor = (name: CommandName): Category => {
  if (name === "event" || name === "active" || name === "upcoming")
    return "Events";

  if (name === "craft" || name === "recycle" || name === "recycleto")
    return "Workshop";

  return "Items";
};

export const visibleCommands = (category: Category) =>
  Arr.filter(
    commandCatalog,
    (command) => category === "All" || categoryFor(command.name) === category,
  );

export const Author = Schema.Literals([
  "scrappy",
  "luna_loots",
  "moss",
  "raider_elle",
  "You",
  "ARCToolsBot",
]);

export const ChatLine = Schema.Struct({
  id: Schema.Int,
  author: Author,
  text: Schema.String,
});

export type ChatLine = typeof ChatLine.Type;

const sampleReplies = {
  find: "Sensors can be found in Security, Technological areas and can be dropped by Snitch, ARC Surveyor.",
  recycle:
    "These items are granted for recycling Sensors: Metal Parts (x1), Wires (x1)",
  event: "Harvester on Blue Gate starts in 18m",
};

export const samples = [
  {
    command: "!find sensors",
    answer: sampleReplies.find,
  },
  {
    command: "!recycle sensors",
    answer: sampleReplies.recycle,
  },
  {
    command: "!event harvester",
    answer: sampleReplies.event,
  },
];

export const replyFor = (text: string) =>
  Arr.findFirst(samples, (sample) => sample.command === Str.toLowerCase(text));

export const chatLoop: ReadonlyArray<Omit<ChatLine, "id">> = [
  { author: "scrappy", text: "that was way too close" },
  { author: "luna_loots", text: "did you grab the sensors?" },
  { author: "moss", text: "check the next building" },
  { author: "raider_elle", text: "!find sensors" },
  {
    author: "ARCToolsBot",
    text: "@raider_elle " + sampleReplies.find,
  },
  { author: "scrappy", text: "nice, one less tab open" },
  { author: "luna_loots", text: "!recycle sensors" },
  {
    author: "ARCToolsBot",
    text: "@luna_loots " + sampleReplies.recycle,
  },
  { author: "moss", text: "we have room for one more run" },
  { author: "raider_elle", text: "!event harvester" },
  {
    author: "ARCToolsBot",
    text: "@raider_elle " + sampleReplies.event,
  },
  { author: "scrappy", text: "squad ready? let’s head topside" },
];
