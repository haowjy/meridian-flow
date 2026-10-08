/** Search match kernel: what a hit carries back, and what the count is a count of. */
import { describe, expect, it } from "vitest";
import { matchDocument, PASSAGE_CAP } from "./match.js";

const HASHLINES = { hashlines: true };
const PLAIN = { hashlines: false };

describe("matchDocument", () => {
  it("carries every matching block's hash and counts every occurrence", () => {
    const match = matchDocument(
      ["aa11|Elara waited.", "bb22|The hall was empty.", "cc33|Elara left, and Elara stayed."],
      "elara",
      HASHLINES,
    );
    expect(match).toEqual({
      matches: [
        { excerpt: "Elara waited.", blockHash: "aa11" },
        { excerpt: "Elara left, and Elara stayed.", blockHash: "cc33" },
      ],
      matchCount: 3,
    });
  });

  it("matches the writer's text and the escaped form inside serialized markdown", () => {
    const blocks = ["aa11|Fireball LIVE\\_ONLY.", "bb22|&#x20;Leading \\[Skill] live\\_only."];

    expect(matchDocument(blocks, "LIVE_ONLY", HASHLINES)?.matchCount).toBe(2);
    expect(matchDocument(blocks, "LIVE\\_ONLY", HASHLINES)?.matchCount).toBe(2);
    expect(matchDocument(blocks, " Leading [Skill]", HASHLINES)?.matches).toEqual([
      { excerpt: "&#x20;Leading \\[Skill] live\\_only.", blockHash: "bb22" },
    ]);
  });

  it("caps the passages it shows and keeps counting past the cap", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => `aa0${index}|Elara ${index}.`);

    const match = matchDocument(blocks, "elara", HASHLINES);

    expect(match?.matches).toHaveLength(PASSAGE_CAP);
    expect(match?.matches.at(-1)?.excerpt).toBe("Elara 2.");
    // The number is about the document; the list is about what fits.
    expect(match?.matchCount).toBe(6);
  });

  it("returns null when nothing matches", () => {
    expect(matchDocument(["aa11|nothing"], "dragon", HASHLINES)).toBeNull();
    expect(matchDocument(["aa11|nothing"], "", HASHLINES)).toBeNull();
  });
});
