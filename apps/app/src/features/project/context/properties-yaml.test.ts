/** Block YAML for the values a chip or a word can't show. */
import { describe, expect, it } from "vitest";
import { isChipList, isEmptyValue, toYamlBlock } from "./properties-yaml";

describe("toYamlBlock", () => {
  it("writes a list of maps with the dash sharing its first key", () => {
    expect(
      toYamlBlock([
        { book: "Ashfall", page: 12 },
        { book: "Cinders", page: 3 },
      ]),
    ).toBe("- book: Ashfall\n  page: 12\n- book: Cinders\n  page: 3");
  });

  it("nests maps and lists under their key", () => {
    expect(toYamlBlock({ origin: { sect: "Outer", ranks: ["a", "b"] }, tags: [] })).toBe(
      "origin:\n  sect: Outer\n  ranks:\n    - a\n    - b\ntags: []",
    );
  });

  it("quotes strings that would read as another type or as syntax", () => {
    expect(toYamlBlock({ a: "true", b: "12", c: "x: y", d: "", e: "plain words" })).toBe(
      'a: "true"\nb: "12"\nc: "x: y"\nd: ""\ne: plain words',
    );
  });
});

describe("value shapes", () => {
  it("shows only flat lists of words, numbers and flags as chips", () => {
    expect(isChipList(["a", 2, true])).toBe(true);
    expect(isChipList([])).toBe(false);
    expect(isChipList(["a", { b: 1 }])).toBe(false);
    expect(isChipList(["a", null])).toBe(false);
  });

  it("calls null, blanks and empty containers empty", () => {
    for (const value of [null, "", [], {}]) expect(isEmptyValue(value)).toBe(true);
    for (const value of [0, false, "x", [0], { a: 1 }]) expect(isEmptyValue(value)).toBe(false);
  });
});
