import { Array as Arr, String as Str } from "effect";

export interface SlashOption {
  readonly name: string;
  readonly description: string;
  readonly type: "string";
  readonly required?: boolean;
}

interface CommandMetadata {
  readonly name: string;
  readonly description: string;
  readonly slashOptions: readonly SlashOption[];
  readonly exampleArguments: Readonly<Record<string, string>>;
}

const ITEM_OPTION = {
  name: "item",
  description: "Item name",
  type: "string",
  required: true,
} as const satisfies SlashOption;

const ARC_OPTION = {
  name: "arc",
  description: "Arc name",
  type: "string",
  required: true,
} as const satisfies SlashOption;

const definitions = [
  {
    name: "buy",
    description: "Get the trader that sells an item and its price.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "loot",
    description: "Get the items dropped by an arc.",
    slashOptions: [ARC_OPTION],
    exampleArguments: { arc: "bastion" },
  },
  {
    name: "craft",
    description: "Get the required items and workbench to craft an item.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "find",
    description: "Get the loot areas where an item can be found.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "sell",
    description: "Get the sell value of an item.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "recycle",
    description: "Get the items granted for recycling an item.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "recycleto",
    description: "Get all items that recycle into a specific item.",
    slashOptions: [ITEM_OPTION],
    exampleArguments: { item: "sensors" },
  },
  {
    name: "event",
    description:
      "Get currently active or upcoming events by event or map name.",
    slashOptions: [
      {
        name: "event_or_map",
        description: "Event or map name",
        type: "string",
        required: true,
      },
    ],
    exampleArguments: { event_or_map: "harvester" },
  },
  {
    name: "upcoming",
    description: "Display all upcoming events within the next 2 hours.",
    slashOptions: [],
    exampleArguments: {},
  },
  {
    name: "active",
    description: "Display all currently active events.",
    slashOptions: [],
    exampleArguments: {},
  },
] as const satisfies readonly CommandMetadata[];

function invocations(command: CommandMetadata) {
  const argumentsFor = (example: boolean, discord: boolean) =>
    Arr.map(command.slashOptions, (option) => {
      const value = example
        ? (command.exampleArguments[option.name] ?? "")
        : `<${Str.replaceAll("_", " ")(option.name)}>`;

      const argument = discord ? `${option.name}:${value}` : value;

      return !example && !option.required ? `[${argument}]` : argument;
    });

  const invocation = (example: boolean, discord: boolean) =>
    Arr.join(
      [
        `${discord ? "/" : "!"}${command.name}`,
        ...argumentsFor(example, discord),
      ],
      " ",
    );

  return {
    usage: {
      twitch: invocation(false, false),
      discord: invocation(false, true),
    },
    example: {
      twitch: invocation(true, false),
      discord: invocation(true, true),
    },
  } as const;
}

export const commandCatalog = Object.freeze(
  Arr.map(definitions, (command) => ({
    ...command,
    ...invocations(command),
  })),
);

export type CommandName = (typeof commandCatalog)[number]["name"];
