// Contract tests for canonical sealed-writer-lineage range tokens.
import { describe, expect, it } from "vitest";
import {
  groupLineageRanges,
  intersectLineageRanges,
  lineageRangesContain,
  normalizeLineageRanges,
  parseSealedWriterLineageV3,
  sealedWriterLineageV3,
  subtractLineageRanges,
  validateWriterProtectionScope,
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

  it("intersects, tests membership, and groups through the same normalized algebra", () => {
    const ranges = [
      { clientID: 2, clock: 4, length: 2 },
      { clientID: 1, clock: 0, length: 5 },
      { clientID: 2, clock: 2, length: 2 },
    ];
    expect(intersectLineageRanges(ranges, [{ clientID: 1, clock: 3, length: 5 }])).toEqual([
      { clientID: 1, clock: 3, length: 2 },
    ]);
    expect(lineageRangesContain(ranges, { clientID: 2, clock: 2, length: 4 })).toBe(true);
    expect([...groupLineageRanges(ranges)]).toEqual([
      [1, [{ clientID: 1, clock: 0, length: 5 }]],
      [2, [{ clientID: 2, clock: 2, length: 4 }]],
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
      expect(() =>
        sealedWriterLineageV3({
          documentId: "doc-1",
          protectedRoots: ranges,
          responseCausalCutId: "cut-1",
        }),
      ).toThrow();
    });
  }

  it("allows empty tokens and rejects non-canonical persisted tokens", () => {
    expect(
      sealedWriterLineageV3({
        documentId: "doc-1",
        protectedRoots: [],
        responseCausalCutId: "cut-1",
      }).protectedRoots,
    ).toEqual([]);
    expect(() =>
      parseSealedWriterLineageV3({
        version: 3,
        documentId: "doc-1",
        responseCausalCutId: "cut-1",
        protectedRoots: [
          { clientID: 1, clock: 0, length: 4 },
          { clientID: 1, clock: 3, length: 2 },
        ],
      }),
    ).toThrow(/merged and non-overlapping/);
    expect(() =>
      parseSealedWriterLineageV3({
        version: 2,
        documentId: "doc-1",
        responseCausalCutId: "cut-1",
        protectedRoots: [],
      }),
    ).toThrow();
  });

  it("blocks a protection token when any root is unresolved or non-writer", () => {
    const token = sealedWriterLineageV3({
      documentId: "doc-1",
      protectedRoots: [{ clientID: 1, clock: 2, length: 3 }],
      responseCausalCutId: "cut-1",
    });
    expect(() => validateWriterProtectionScope(token, { provenanceOf: () => null })).toThrow(
      /unresolved/,
    );
    expect(() => validateWriterProtectionScope(token, { provenanceOf: () => "agent" })).toThrow(
      /non-writer/,
    );
    expect(validateWriterProtectionScope(token, { provenanceOf: () => "writer_protected" })).toBe(
      token,
    );
  });
});
