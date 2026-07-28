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

  it("caps the passages it shows and keeps counting past the cap", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => `aa0${index}|Elara ${index}.`);

    const match = matchDocument(blocks, "elara", HASHLINES);

    expect(match?.matches).toHaveLength(PASSAGE_CAP);
    expect(match?.matches.at(-1)?.excerpt).toBe("Elara 2.");
    // The number is about the document; the list is about what fits.
    expect(match?.matchCount).toBe(6);
  });

  it("never counts the hash itself", () => {
    // "cafe" is hex, so a hash can spell a query the writer's prose does not.
    expect(
      matchDocument(["cafe|nothing here", "beef|the cafe was closed"], "cafe", HASHLINES),
    ).toEqual({
      matches: [{ excerpt: "the cafe was closed", blockHash: "beef" }],
      matchCount: 1,
    });
  });

  it("omits the hash when a serialized block has none, and its separator with it", () => {
    // `stripBlockHash` correctly refuses this line — an empty prefix is not a
    // hash — so leaving the separator on would have shown the writer a pipe.
    expect(matchDocument(["|unhashed body"], "unhashed", HASHLINES)).toEqual({
      matches: [{ excerpt: "unhashed body" }],
      matchCount: 1,
    });
  });

  it("hands back prose, never the addressing prefix around it", () => {
    const match = matchDocument(["aa11|Elara waited."], "elara", HASHLINES);

    expect(match?.matches[0].excerpt).toBe("Elara waited.");
    expect(match?.matches[0].excerpt).not.toContain("|");
    expect(match?.matches[0].blockHash).toBe("aa11");
  });

  it("treats plain markdown as lines and never splits a table row into a hash", () => {
    expect(matchDocument(["| name | role |", "| Elara | envoy |"], "elara", PLAIN)).toEqual({
      matches: [{ excerpt: "| Elara | envoy |" }],
      matchCount: 1,
    });
  });

  it("returns null when nothing matches", () => {
    expect(matchDocument(["aa11|nothing"], "dragon", HASHLINES)).toBeNull();
    expect(matchDocument(["aa11|nothing"], "", HASHLINES)).toBeNull();
  });
});
