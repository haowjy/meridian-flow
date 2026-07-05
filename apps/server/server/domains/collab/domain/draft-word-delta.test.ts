/** Unit coverage for draft word-delta counting from visible review text. */
import { describe, expect, it } from "vitest";
import { countWhitespaceSeparatedWords, sumDraftWordDelta } from "./draft-word-delta.js";

describe("draft word deltas", () => {
  it("counts whitespace-separated visible words", () => {
    expect(countWhitespaceSeparatedWords("  Alpha\n\tbeta   gamma  ")).toBe(3);
    expect(countWhitespaceSeparatedWords("   ")).toBe(0);
  });

  it("sums inserted and removed visible text independently", () => {
    expect(
      sumDraftWordDelta([
        { insertedText: "new bold words", deletedText: "old" },
        { insertedText: "", deletedText: "two removed" },
      ]),
    ).toEqual({ wordsAdded: 3, wordsRemoved: 3 });
  });
});
