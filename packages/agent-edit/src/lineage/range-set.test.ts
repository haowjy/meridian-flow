// Contract tests for canonical sealed-writer-lineage range tokens.
import { describe, expect, it } from "vitest";
import {
  normalizeLineageRanges,
  parseSealedWriterLineageV2,
  sealedWriterLineageV2,
  subtractLineageRanges,
} from "./range-set.js";

describe("sealed writer lineage ranges", () => {
  it("sorts and merges touching or overlapping ranges only within one client", () => {
    expect(
      normalizeLineageRanges([
        { clientID: 2, clock: 5, length: 2 },
        { clientID: 1, clock: 4, length: 3 },
        { clientID: 1, clock: 0, length: 5 },
        { clientID: 2, clock: 6, length: 3 },
      ]),
    ).toEqual([
      { clientID: 1, clock: 0, length: 7 },
      { clientID: 2, clock: 5, length: 4 },
    ]);
  });

  it("subtracts partial and disjoint coverage as half-open intervals", () => {
    expect(
      subtractLineageRanges(
        [{ clientID: 1, clock: 0, length: 10 }],
        [{ clientID: 1, clock: 2, length: 3 }],
        [
          { clientID: 1, clock: 8, length: 2 },
          { clientID: 2, clock: 0, length: 20 },
        ],
      ),
    ).toEqual([
      { clientID: 1, clock: 0, length: 2 },
      { clientID: 1, clock: 5, length: 3 },
    ]);
  });

  const invalidRanges = [
    [{ clientID: 1, clock: 0, length: 0 }],
    [{ clientID: -1, clock: 0, length: 1 }],
    [{ clientID: 1, clock: -1, length: 1 }],
    [{ clientID: 1.5, clock: 0, length: 1 }],
    [{ clientID: 1, clock: Number.MAX_SAFE_INTEGER, length: 1 }],
  ];
  for (const ranges of invalidRanges) {
    it(`rejects invalid ranges: ${JSON.stringify(ranges)}`, () => {
      expect(() => sealedWriterLineageV2({ documentId: "doc-1", ranges })).toThrow();
    });
  }

  it("rejects empty and non-canonical persisted tokens", () => {
    expect(() => sealedWriterLineageV2({ documentId: "doc-1", ranges: [] })).toThrow();
    expect(() =>
      parseSealedWriterLineageV2({
        version: 2,
        documentId: "doc-1",
        ranges: [
          { clientID: 1, clock: 0, length: 4 },
          { clientID: 1, clock: 3, length: 2 },
        ],
      }),
    ).toThrow(/merged and non-overlapping/);
    expect(() =>
      parseSealedWriterLineageV2({ version: 3, documentId: "doc-1", ranges: [] }),
    ).toThrow();
  });
});
