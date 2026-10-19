import { describe, expect, test } from "bun:test";

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
      "a".repeat(495),
      "👨🏽‍💻 ".repeat(180),
      "a\n \t".repeat(500),
    ]) {
      const parts = twitchParts(input);
      expect(parts.length).toBeLessThanOrEqual(8);
      expect(parts.every((part) => part.length <= 500)).toBeTrue();
      expect(
        parts.map((part) => part.replace(/^\[\d\/\d\]: /, "")).join(""),
      ).toBe(input);
      expect(twitchParts(input)).toEqual(parts);
      expect(parts.some((part) => /[\uD800-\uDBFF]$/.test(part))).toBeFalse();
    }
  });
  test("oversized plans fail explicitly without a partial result", () => {
    expect(twitchParts("a".repeat(4000))).toEqual([oversized]);
    expect(discordResponse("a".repeat(2001))).toEqual(
      discordResponse(oversized, true),
    );
    expect(discordResponse("\u0000".repeat(2000))).toEqual(
      discordResponse(oversized, true),
    );
  });
  test("single replies and fallbacks have no label while multiple parts retain their order", () => {
    expect(twitchParts("Sensors")).toEqual(["Sensors"]);
    expect(twitchParts("!sell sensors")).toEqual(["!sell sensors"]);
    expect(twitchParts("")).toEqual([friendlyFailure]);
    expect(twitchParts("a".repeat(496))).toEqual([
      `[1/2]: ${"a".repeat(489)}`,
      `[2/2]: ${"a".repeat(7)}`,
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
    expect(discordResponse("😀".repeat(1000)).data.content).toBe(
      "😀".repeat(1000),
    );
    expect(discordResponse("😀".repeat(1001)).data.content).toBe(oversized);
  });
});
