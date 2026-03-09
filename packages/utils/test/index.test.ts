import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  normalize,
  parseMessageParams,
  slugify,
  sortByDesc,
} from "../src/index.js";

describe("parseMessageParams", () => {
  it("trims segments and removes empty parts", () => {
    expect(parseMessageParams(["  a  ", "", "  b  ", " "])).toBe("a b");
  });

  it("preserves word order", () => {
    expect(parseMessageParams(["first", "second", "third"])).toBe(
      "first second third",
    );
  });

  it("handles all-empty input", () => {
    expect(parseMessageParams(["", " ", "  "])).toBe("");
  });

  it("handles single non-empty segment", () => {
    expect(parseMessageParams(["item"])).toBe("item");
  });

  it("handles empty array", () => {
    expect(parseMessageParams([])).toBe("");
  });
});

describe("formatMinutes", () => {
  it("formats sub-hour values as minutes", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(30_000)).toBe("0m");
    expect(formatMinutes(59_000)).toBe("0m");
    expect(formatMinutes(60_000)).toBe("1m");
    expect(formatMinutes(90_000)).toBe("1m");
    expect(formatMinutes(3540_000)).toBe("59m");
  });

  it("formats exact hour boundaries", () => {
    expect(formatMinutes(3600_000)).toBe("1h");
    expect(formatMinutes(7200_000)).toBe("2h");
  });

  it("formats mixed hour and minute values", () => {
    expect(formatMinutes(3660_000)).toBe("1h 1m");
    expect(formatMinutes(7320_000)).toBe("2h 2m");
    expect(formatMinutes(5400_000)).toBe("1h 30m");
  });

  it("handles zero", () => {
    expect(formatMinutes(0)).toBe("0m");
  });

  it("handles negative duration (current behavior)", () => {
    const result = formatMinutes(-60_000);
    expect(result).toBe("-1m");
  });
});

describe("normalize", () => {
  it("lowercases input", () => {
    expect(normalize("ABC")).toBe("abc");
    expect(normalize("AbCdEf")).toBe("abcdef");
  });

  it("removes whitespace", () => {
    expect(normalize("a b c")).toBe("abc");
    expect(normalize("  hello  world  ")).toBe("helloworld");
  });

  it("handles already-normalized input", () => {
    expect(normalize("abc")).toBe("abc");
  });

  it("retains punctuation and hyphens", () => {
    expect(normalize("a-b")).toBe("a-b");
    expect(normalize("hello!")).toBe("hello!");
  });

  it("handles empty string", () => {
    expect(normalize("")).toBe("");
  });
});

describe("slugify", () => {
  it("trims input", () => {
    expect(slugify("  hello  ")).toBe("hello");
  });

  it("lowercases input", () => {
    expect(slugify("Hello")).toBe("hello");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugify("a b c")).toBe("a-b-c");
  });

  it("handles repeated whitespace", () => {
    expect(slugify("a   b")).toBe("a-b");
  });

  it("removes punctuation", () => {
    expect(slugify("hello!")).toBe("hello");
  });

  it("normalizes underscores and repeated hyphens", () => {
    expect(slugify("a__b")).toBe("a-b");
    expect(slugify("a----b")).toBe("a-b");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("sortByDesc", () => {
  it("sorts by key in descending order", () => {
    const items = [
      { name: "a", value: 1 },
      { name: "b", value: 3 },
      { name: "c", value: 2 },
    ];
    const sorted = sortByDesc(items, (i) => i.value);
    expect(sorted).toEqual([
      { name: "b", value: 3 },
      { name: "c", value: 2 },
      { name: "a", value: 1 },
    ]);
  });

  it("does not mutate input", () => {
    const items = [{ v: 2 }, { v: 1 }];
    const original = [...items];
    sortByDesc(items, (i) => i.v);
    expect(items).toEqual(original);
  });

  it("handles ties (preserves relative order)", () => {
    const items = [
      { id: "a", v: 1 },
      { id: "b", v: 1 },
      { id: "c", v: 1 },
    ];
    const sorted = sortByDesc(items, (i) => i.v);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("handles empty array", () => {
    expect(sortByDesc([], (x: number) => x)).toEqual([]);
  });
});
