import { describe, expect, it, vi } from "vitest";

import {
  boundLabel,
  matchCountLabel,
  moreMatchesLabel,
  normalizeListing,
  normalizeSearchHits,
  searchCardSummary,
} from "./tool-result-preview";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

describe("the caller picks the parser", () => {
  it("reads every listing entry, even after one that looks like a search hit", () => {
    // Shape-sniffing classified a whole array from its first recognizable
    // entry, so one odd row upstream discarded every valid row behind it.
    const rows = normalizeListing([
      { uri: "manuscript://stray.md", excerpt: "not a listing field" },
      { uri: "manuscript://arc-one", kind: "directory" },
      { uri: "manuscript://chapter-1.md", kind: "file" },
    ]);

    expect(rows.rows).toEqual([
      { kind: "folder", uri: "manuscript://arc-one" },
      { kind: "document", uri: "manuscript://chapter-1.md" },
    ]);
    expect(rows.total).toBe(3);
  });

  it("reads every search hit, even after one that looks like a listing entry", () => {
    const rows = normalizeSearchHits(
      [
        { uri: "manuscript://arc-one", kind: "directory" },
        {
          uri: "manuscript://chapter-2.md",
          matches: [{ excerpt: "The hollow gate stood." }],
          matchCount: 1,
        },
      ],
      "gate",
    );

    expect(rows.rows).toEqual([
      {
        uri: "manuscript://chapter-2.md",
        matchCount: 1,
        passages: [
          { excerpt: { lead: "The hollow ", match: "gate", trail: " stood.", clipped: false } },
        ],
      },
    ]);
    expect(rows.total).toBe(2);
  });

  it("never reads a listing as search hits, whatever the entries look like", () => {
    // A listing entry has no passage, so reading it as a hit yields nothing —
    // which is the point: the tool decides, not the payload.
    expect(normalizeSearchHits([{ uri: "manuscript://chapter-1.md", kind: "file" }]).rows).toEqual(
      [],
    );
  });

  it("skips malformed entries without stopping at them", () => {
    const rows = normalizeListing([
      null,
      "not an object",
      { kind: "file" },
      { uri: "manuscript://chapter-1.md", kind: "file" },
    ]);

    expect(rows.rows).toEqual([{ kind: "document", uri: "manuscript://chapter-1.md" }]);
    // The bound reports the payload's size, not what we could parse.
    expect(rows.total).toBe(4);
  });

  it("returns nothing for a payload that is not a list at all", () => {
    expect(normalizeListing({ results: [] }).rows).toEqual([]);
    expect(normalizeSearchHits(undefined).rows).toEqual([]);
  });
});

describe("caps and bounds", () => {
  const listing = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      uri: `manuscript://chapter-${index + 1}.md`,
      kind: "file",
    }));

  it("stops a listing at eight and states the rest", () => {
    const rows = normalizeListing(listing(23));

    expect(rows.rows).toHaveLength(8);
    expect(boundLabel(rows)).toBe("8 of 23");
  });

  it("stops search hits at four, because each one is a section", () => {
    const hits = Array.from({ length: 42 }, (_, index) => ({
      uri: `manuscript://chapter-${index + 1}.md`,
      matches: [{ excerpt: "The hollow gate stood." }],
      matchCount: 1,
    }));

    expect(normalizeSearchHits(hits).rows).toHaveLength(4);
    expect(boundLabel(normalizeSearchHits(hits))).toBe("4 of 42");
  });

  it("states no bound when nothing was cut", () => {
    expect(boundLabel(normalizeListing(listing(3)))).toBeNull();
  });
});

describe("what a search says it found", () => {
  const hit = (index: number, matchCount: number, passages = 1) => ({
    uri: `manuscript://chapter-${index}.md`,
    matches: Array.from({ length: passages }, (_, at) => ({
      excerpt: `Elara waited ${at}.`,
      blockHash: `79b${at}`,
    })),
    matchCount,
  });

  it("carries every passage with the hash and term its door needs", () => {
    const rows = normalizeSearchHits([hit(1, 5, 2)], "elara");

    expect(rows.rows[0]).toEqual({
      uri: "manuscript://chapter-1.md",
      matchCount: 5,
      passages: [
        {
          excerpt: { lead: "", match: "Elara", trail: " waited 0.", clipped: false },
          passage: { blockHash: "79b0", term: "elara" },
        },
        {
          excerpt: { lead: "", match: "Elara", trail: " waited 1.", clipped: false },
          passage: { blockHash: "79b1", term: "elara" },
        },
      ],
    });
  });

  it("leaves a passage with no hash unable to promise a destination", () => {
    const rows = normalizeSearchHits(
      [{ uri: "kb://elara.md", matches: [{ excerpt: "A scout from the Vale." }], matchCount: 2 }],
      "scout",
    );

    expect(rows.rows[0].passages[0]).not.toHaveProperty("passage");
  });

  it("refuses a hit the contract says cannot exist, rather than rendering around it", () => {
    const reject = (entry: unknown) =>
      expect(normalizeSearchHits([entry as never], "x").rows).toEqual([]);

    reject({ uri: "manuscript://a.md", matches: [], matchCount: 1 });
    reject({ uri: "manuscript://a.md", matchCount: 1 });
    reject({ uri: "manuscript://a.md", matches: [{ excerpt: "x is here." }] });
    reject({ uri: "manuscript://a.md", matches: [{ excerpt: "x is here." }], matchCount: 0 });
  });

  it("heads the card with totals counted across the whole payload", () => {
    const hits = Array.from({ length: 6 }, (_, index) => hit(index + 1, 2));

    expect(searchCardSummary(normalizeSearchHits(hits, "elara"))).toBe("12 results in 6 documents");
  });

  it("drops to the document count while results would say the same thing twice", () => {
    const hits = Array.from({ length: 42 }, (_, index) => hit(index + 1, 1));

    expect(searchCardSummary(normalizeSearchHits(hits, "elara"))).toBe("42 documents");
    // How many were shown is a different fact, and it keeps its own line.
    expect(boundLabel(normalizeSearchHits(hits, "elara"))).toBe("4 of 42");
  });

  it("claims no total when the payload holds an entry it cannot count", () => {
    // `total` is the payload's size; a rejected entry still counted toward it,
    // so the header must not multiply out a total it cannot stand behind.
    const hits = [hit(1, 3), { uri: "kb://elara.md", matches: [{ excerpt: "A scout." }] }];

    expect(searchCardSummary(normalizeSearchHits(hits, "elara"))).toBe("2 documents");
  });

  it("says what a count badge means for anyone who cannot see the column", () => {
    expect(matchCountLabel(5)).toBe("5 matches");
    expect(matchCountLabel(1)).toBe("1 match");
    expect(moreMatchesLabel(2)).toBe("2 more");
  });
});
