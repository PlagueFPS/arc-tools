import { describe, expect, test } from "bun:test";

import { Array as Arr, String as Str } from "effect";

import {
  discordResponse,
  friendlyFailure,
  oversized,
  twitchParts,
} from "../src/presentation.js";

describe("transport presentation", () => {
  test("Twitch breaks accidental username mentions without removing their text", () => {
    expect(twitchParts("Look @player and @everyone")).toEqual([
      "Look @\u200bplayer and @\u200beveryone",
    ]);
  });
  test("keeps all Unicode and whitespace across deterministic parts within 500 UTF-16 units", () => {
    for (const input of [
      "Sensors",
      "!sell sensors",
      Str.repeat(495)("a"),
      Str.repeat(180)("👨🏽‍💻 "),
      Str.repeat(500)("a\n \t"),
    ]) {
      const parts = twitchParts(input);
      expect(parts.length).toBeLessThanOrEqual(8);
      expect(Arr.every(parts, (part) => !!(part.length <= 500))).toBeTrue();
      expect(
        Arr.join(
          Arr.map(parts, (part) => Str.replace(/^\[\d\/\d\]: /, "")(part)),
          "",
        ),
      ).toBe(input);
      expect(twitchParts(input)).toEqual(parts);
      expect(
        Arr.some(parts, (part) => !!/[\uD800-\uDBFF]$/.test(part)),
      ).toBeFalse();
    }
  });
  test("oversized plans fail explicitly without a partial result", () => {
    expect(twitchParts(Str.repeat(4000)("a"))).toEqual([oversized]);
    expect(discordResponse(Str.repeat(2001)("a"))).toEqual(
      discordResponse(oversized, true),
    );
    expect(discordResponse(Str.repeat(2000)("\u0000"))).toEqual(
      discordResponse(oversized, true),
    );
  });
  test("single replies and fallbacks have no label while multiple parts retain their order", () => {
    expect(twitchParts("Sensors")).toEqual(["Sensors"]);
    expect(twitchParts("!sell sensors")).toEqual(["!sell sensors"]);
    expect(twitchParts("")).toEqual([friendlyFailure]);
    expect(twitchParts(Str.repeat(496)("a"))).toEqual([
      `[1/2]: ${Str.repeat(489)("a")}`,
      `[2/2]: ${Str.repeat(7)("a")}`,
    ]);
    expect(twitchParts("ARC Raiders")).toEqual(["ARC Raiders"]);
  });
  test("Discord success is public and complete while errors are private with every mention disabled", () => {
    expect(discordResponse("@everyone <@123> 👋")).toEqual({
      type: 4,
      data: {
        content: "@everyone <@123> 👋",
        flags: 0,
        allowed_mentions: { parse: [], replied_user: false },
      },
    });
    expect(discordResponse("Failure", true).data.flags).toBe(64);
    expect(discordResponse(Str.repeat(1000)("😀")).data.content).toBe(
      Str.repeat(1000)("😀"),
    );
    expect(discordResponse(Str.repeat(1001)("😀")).data.content).toBe(
      oversized,
    );
  });
});
