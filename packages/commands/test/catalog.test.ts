/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
import { expect, test } from "bun:test";

import { commandCatalog } from "@arctools/commands/catalog";
import {
  CommandExecution,
  CommandName as CommandNameSchema,
} from "@arctools/commands/schemas";
import {
  Schema,
  Option as EffectOption,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";

test("usage shows provider syntax for item, event and argument-free commands", () => {
  const sell = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      commandCatalog,
      (command) => !!(command.name === "sell"),
    ),
  );

  const event = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      commandCatalog,
      (command) => !!(command.name === "event"),
    ),
  );

  const active = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      commandCatalog,
      (command) => !!(command.name === "active"),
    ),
  );

  expect(sell?.exampleArguments).toEqual({ item: "sensors" });
  expect(sell?.usage).toEqual({
    twitch: "!sell <item>",
    discord: "/sell item:<item>",
  });
  expect(sell?.example).toEqual({
    twitch: "!sell sensors",
    discord: "/sell item:sensors",
  });
  expect(event?.usage).toEqual({
    twitch: "!event <event or map>",
    discord: "/event event_or_map:<event or map>",
  });
  expect(event?.example).toEqual({
    twitch: "!event harvester",
    discord: "/event event_or_map:harvester",
  });
  expect(active?.usage).toEqual({ twitch: "!active", discord: "/active" });
  expect(active?.example).toEqual(active?.usage);
});

test("catalog names drive runtime recognition and every example fills its options", () => {
  const names = EffectArray.map(commandCatalog, (command) => command.name);

  expect(new Set(names).size).toBe(names.length);

  for (const command of commandCatalog) {
    expect(Schema.is(CommandNameSchema)(command.name)).toBe(true);
    expect(
      Schema.is(CommandExecution)({
        command: command.name,
        input: "",
        deadline: 0,
      }),
    ).toBe(true);
    expect(
      EffectRecord.keys<string, string>(command.exampleArguments).sort(),
    ).toEqual(
      EffectArray.map(command.slashOptions, (option) => option.name).sort(),
    );
    expect(
      EffectArray.every(
        EffectRecord.values<string, string>(command.exampleArguments),
        (value) => !!(value.length > 0),
      ),
    ).toBe(true);
  }

  expect(Schema.is(CommandNameSchema)("unknown")).toBe(false);
  expect(
    Schema.is(CommandExecution)({ command: "unknown", input: "", deadline: 0 }),
  ).toBe(false);
  expect(
    Schema.is(CommandExecution)({
      command: "sell",
      input: EffectString.repeat(257)("x"),
      deadline: 0,
    }),
  ).toBe(false);
  expect(
    Schema.is(CommandExecution)({ command: "sell", input: "", deadline: -1 }),
  ).toBe(false);
});

test("the public catalog builds for browsers without server or runtime dependencies", async () => {
  const inputs: string[] = [];

  const result = await Bun.build({
    entrypoints: [new URL("./catalog-browser.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [
      {
        name: "inspect-catalog-dependencies",
        setup(build) {
          build.onLoad({ filter: /./ }, (args) => {
            inputs.push(args.path);
          });
        },
      },
    ],
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(inputs).toContain(
    new URL("../src/catalog.ts", import.meta.url).pathname,
  );
  expect(
    EffectArray.some(
      inputs,
      (path) =>
        !!/node_modules|handlers|arc-data|execute|schemas|config|alchemy/.test(
          path,
        ),
    ),
  ).toBe(false);
  expect(inputs.length).toBeGreaterThan(0);
});
