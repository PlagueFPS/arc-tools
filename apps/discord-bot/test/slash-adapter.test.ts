import { type CommandDefinition, commands } from "@arctools/commands";
import { ApplicationCommandOptionType } from "discord.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { toDiscordPayload } from "../src/slash-adapter.js";

describe("toDiscordPayload", () => {
  it("maps every registry command to Discord payload format", () => {
    const payload = toDiscordPayload(commands);
    expect(payload).toHaveLength(commands.length);
    expect(payload.map((p) => p.name)).toEqual(commands.map((c) => c.name));
  });

  it("preserves name and description for each command", () => {
    const payload = toDiscordPayload(commands);
    for (let i = 0; i < commands.length; i++) {
      const p = payload[i];
      const c = commands[i];
      expect(p).toBeDefined();
      expect(c).toBeDefined();
      expect(p?.name).toBe(c?.name);
      expect(p?.description).toBe(c?.description);
    }
  });

  it("maps slashOptions with required defaulting to true when omitted", () => {
    const payload = toDiscordPayload(commands);
    const buyPayload = payload.find((p) => p.name === "buy");
    expect(buyPayload).toBeDefined();
    const opt = buyPayload?.options[0];
    expect(opt).toBeDefined();
    expect(buyPayload?.options).toHaveLength(1);
    expect(opt?.type).toBe(ApplicationCommandOptionType.String);
    expect(opt?.name).toBe("item");
    expect(opt?.required).toBe(true);
  });

  it("uses ApplicationCommandOptionType.String for all options", () => {
    const payload = toDiscordPayload(commands);
    for (const cmd of payload) {
      for (const opt of cmd.options) {
        expect(opt.type).toBe(ApplicationCommandOptionType.String);
      }
    }
  });

  it("commands with no slashOptions have empty options array", () => {
    const payload = toDiscordPayload(commands);
    const upcoming = payload.find((p) => p.name === "upcoming");
    const active = payload.find((p) => p.name === "active");
    expect(upcoming?.options).toEqual([]);
    expect(active?.options).toEqual([]);
  });

  it("honors explicit required: false when provided", () => {
    const customCommands: CommandDefinition[] = [
      {
        name: "custom",
        description: "Custom",
        usage: "!custom",
        slashOptions: [
          {
            name: "opt",
            description: "Opt",
            type: "string",
            required: false,
          },
        ],
        handler: () => Effect.succeed("ok"),
      },
    ];
    const payload = toDiscordPayload(customCommands);
    const first = payload[0];
    const opt = first?.options[0];
    expect(first).toBeDefined();
    expect(opt).toBeDefined();
    expect(opt?.required).toBe(false);
  });
});
