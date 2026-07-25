import { describe, expect, it } from "vitest";
import { countWords, wordDeltaBetweenHashlines, wordDeltaBetweenTexts } from "./word-count.js";

describe("word counting", () => {
  it("uses whitespace-delimited words", () => {
    expect(countWords("  Ashes\n of\t the Vale  ")).toBe(4);
    expect(countWords(" \n ")).toBe(0);
  });

  it("diffs whole word tokens rather than character fragments", () => {
    expect(wordDeltaBetweenTexts("The old gate opened.", "The new gate opened.")).toEqual({
      wordsAdded: 1,
      wordsRemoved: 1,
    });
    expect(wordDeltaBetweenTexts("The old gate opened.", "The new gate opened slowly.")).toEqual({
      wordsAdded: 2,
      wordsRemoved: 1,
    });
    expect(wordDeltaBetweenTexts("The gate remained closed.", "The gate opened.")).toEqual({
      wordsAdded: 1,
      wordsRemoved: 2,
    });
  });

  it("ignores internal hashline identity changes", () => {
    expect(
      wordDeltaBetweenHashlines("7594|The gate remained closed.", "9191|The gate remained closed."),
    ).toEqual({ wordsAdded: 0, wordsRemoved: 0 });
  });
});
