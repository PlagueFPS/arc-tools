import { describe, expect, test } from "bun:test";
import { parseTwitchCommand } from "../src/ingress.js";
import {
  discordResponse,
  oversized,
  twitchParts,
} from "../src/presentation.js";

describe("transport presentation", () => {
  test("Twitch breaks accidental username mentions without removing their text", () => {
    expect(twitchParts("Look @player and @everyone")).toEqual([
      "ARC: Look @\u200bplayer and @\u200beveryone",
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
        parts
          .map((part) => part.replace(/^ARC(?: \[\d\/\d\])?: /, ""))
          .join(""),
      ).toBe(input);
      expect(parts.map(parseTwitchCommand)).toEqual(parts.map(() => null));
      expect(twitchParts(input)).toEqual(parts);
      expect(parts.some((part) => /[\uD800-\uDBFF]$/.test(part))).toBeFalse();
    }
  });
  test("oversized plans fail explicitly without a partial result", () => {
    expect(twitchParts("a".repeat(4000))).toEqual([`ARC: ${oversized}`]);
    expect(discordResponse("a".repeat(2001))).toEqual(
      discordResponse(oversized, true),
    );
    expect(discordResponse("\u0000".repeat(2000))).toEqual(
      discordResponse(oversized, true),
    );
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
