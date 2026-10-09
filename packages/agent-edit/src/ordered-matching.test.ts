// Ordered matching contracts shared by mutation alignment and concurrent attribution.
import { describe, expect, it } from "vitest";
import { weightedOrderedMatches } from "./ordered-matching.js";

describe("weighted ordered matching", () => {
  it("maximizes weight, not pair count, with absolute index bounds", () => {
    const weights = [
      [0, 5],
      [1, 0],
    ];
    expect(weightedOrderedMatches((i, j) => weights[i - 2][j - 3], 2, 4, 3, 5, 9)).toEqual([
      [2, 4],
    ]);
  });
  it("prefers matching then skipping old on ties", () => {
    expect(weightedOrderedMatches(() => 1, 0, 2, 0, 1, 6)).toEqual([[0, 0]]);
    expect(weightedOrderedMatches((i, j) => (i !== j ? 1 : 0), 0, 2, 0, 2, 9)).toEqual([[1, 0]]);
  });
  it("leaves over-limit fallback to the caller and never pairs zero scores", () => {
    expect(weightedOrderedMatches(() => 1, 0, 2, 0, 2, 8)).toBeNull();
    expect(weightedOrderedMatches(() => 0, 0, 2, 0, 2, 9)).toEqual([]);
    expect(weightedOrderedMatches(() => 1, 0, 0, 0, 2, 0)).toEqual([]);
  });
});
