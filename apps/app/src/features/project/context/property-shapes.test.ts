/** Which values show as chips and which as empty. */
import { describe, expect, it } from "vitest";
import { isChipList, isEmptyValue } from "./property-shapes";

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
