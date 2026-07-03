/**
 * Extension unit tests — covers the pure range-coalescing helper the
 * optimistic writer overlay relies on. Runtime behaviour (transaction →
 * decoration) is exercised end-to-end in the browser-prober smoke.
 */
import { describe, expect, it } from "vitest";

import { coalesceRanges } from "./DraftInlineReviewExtension";

describe("coalesceRanges", () => {
  it("merges adjacent single-char ranges (three keystrokes → one range)", () => {
    const merged = coalesceRanges([
      { from: 10, to: 11 },
      { from: 11, to: 12 },
      { from: 12, to: 13 },
    ]);
    expect(merged).toEqual([{ from: 10, to: 13 }]);
  });

  it("merges overlapping ranges", () => {
    const merged = coalesceRanges([
      { from: 5, to: 12 },
      { from: 10, to: 20 },
    ]);
    expect(merged).toEqual([{ from: 5, to: 20 }]);
  });

  it("keeps disjoint ranges separate", () => {
    const merged = coalesceRanges([
      { from: 5, to: 8 },
      { from: 20, to: 25 },
    ]);
    expect(merged).toEqual([
      { from: 5, to: 8 },
      { from: 20, to: 25 },
    ]);
  });

  it("sorts input before merging", () => {
    const merged = coalesceRanges([
      { from: 30, to: 35 },
      { from: 10, to: 15 },
      { from: 15, to: 20 },
    ]);
    expect(merged).toEqual([
      { from: 10, to: 20 },
      { from: 30, to: 35 },
    ]);
  });

  it("drops empty (from >= to) ranges", () => {
    const merged = coalesceRanges([
      { from: 5, to: 5 },
      { from: 10, to: 8 },
      { from: 20, to: 25 },
    ]);
    expect(merged).toEqual([{ from: 20, to: 25 }]);
  });

  it("returns [] for empty input", () => {
    expect(coalesceRanges([])).toEqual([]);
  });
});
