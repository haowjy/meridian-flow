// Contract tests for canonical lineage range algebra.
import { describe, expect, it } from "vitest";
import {
  groupLineageRanges,
  intersectLineageRanges,
  lineageRangesContain,
  normalizeLineageRanges,
  subtractLineageRanges,
} from "./range-set.js";

describe("lineage ranges", () => {
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
});
