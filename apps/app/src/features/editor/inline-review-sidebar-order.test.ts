/**
 * Unit tests for the sidebar ordering + shape derivation logic. Kept pure
 * so we can exercise document-order sorting, shape derivation, and
 * adjacency grouping without spinning up a ProseMirror editor.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import {
  groupAdjacentEntries,
  type HunkPositionRange,
  orderOperationsForSidebar,
} from "./inline-review-sidebar-order";

function op(id: string, kind: ReviewOperation["kind"], hunkCount: number): ReviewOperation {
  return { operationId: id, sourceUpdateIds: [], kind, hunkCount };
}

function hunk(id: string, operationIds: string[], deletedText?: string): ReviewHunk {
  return {
    hunkId: id,
    operationIds,
    anchor: { relStart: "", relEnd: "" },
    ...(deletedText ? { deletedText } : {}),
  };
}

function range(from: number, to: number): HunkPositionRange {
  return { from, to, hasDeletion: false };
}

describe("orderOperationsForSidebar", () => {
  it("sorts operations by earliest resolvable hunk position", () => {
    const operations = [op("op-late", "agent", 1), op("op-early", "agent", 1)];
    const hunks = [hunk("h-late", ["op-late"]), hunk("h-early", ["op-early"])];
    const positions = new Map([
      ["h-late", range(50, 55)],
      ["h-early", range(10, 15)],
    ]);
    const ordered = orderOperationsForSidebar(operations, hunks, positions);
    expect(ordered.map((entry) => entry.operation.operationId)).toEqual(["op-early", "op-late"]);
  });

  it("uses the earliest of an operation's own hunks as the sort key", () => {
    const operations = [op("op-b", "agent", 2), op("op-a", "agent", 1)];
    const hunks = [hunk("h-b-late", ["op-b"]), hunk("h-b-early", ["op-b"]), hunk("h-a", ["op-a"])];
    const positions = new Map([
      ["h-b-late", range(80, 90)],
      ["h-b-early", range(5, 10)],
      ["h-a", range(25, 30)],
    ]);
    const ordered = orderOperationsForSidebar(operations, hunks, positions);
    expect(ordered.map((entry) => entry.operation.operationId)).toEqual(["op-b", "op-a"]);
  });

  it("appends unresolved operations at the end in stable input order", () => {
    const operations = [
      op("op-known", "agent", 1),
      op("op-orphan-a", "agent", 1),
      op("op-orphan-b", "agent", 1),
    ];
    const hunks = [
      hunk("h-known", ["op-known"]),
      hunk("h-a", ["op-orphan-a"]),
      hunk("h-b", ["op-orphan-b"]),
    ];
    const positions = new Map<string, HunkPositionRange | null>([
      ["h-known", range(20, 30)],
      ["h-a", null],
      ["h-b", null],
    ]);
    const ordered = orderOperationsForSidebar(operations, hunks, positions);
    expect(ordered.map((entry) => entry.operation.operationId)).toEqual([
      "op-known",
      "op-orphan-a",
      "op-orphan-b",
    ]);
    expect(ordered[1]?.firstPos).toBe(Number.POSITIVE_INFINITY);
  });

  it("derives insert shape when all hunks are pure insertions", () => {
    const operations = [op("op-i", "agent", 2)];
    const hunks = [hunk("h1", ["op-i"]), hunk("h2", ["op-i"])];
    const positions = new Map([
      ["h1", range(10, 20)],
      ["h2", range(30, 40)],
    ]);
    const [entry] = orderOperationsForSidebar(operations, hunks, positions);
    expect(entry?.shape).toBe("insert");
  });

  it("derives delete shape when all hunks are pure deletions", () => {
    const operations = [op("op-d", "agent", 1)];
    const hunks = [hunk("h-del", ["op-d"], "removed text")];
    const positions = new Map([["h-del", { from: 10, to: 10, hasDeletion: true }]]);
    const [entry] = orderOperationsForSidebar(operations, hunks, positions);
    expect(entry?.shape).toBe("delete");
  });

  it("derives replace shape when every hunk carries both insertion and deletion", () => {
    const operations = [op("op-r", "agent", 1)];
    const hunks = [hunk("h-repl", ["op-r"], "old")];
    const positions = new Map([["h-repl", range(5, 15)]]);
    const [entry] = orderOperationsForSidebar(operations, hunks, positions);
    expect(entry?.shape).toBe("replace");
  });

  it("returns mixed when different hunks of one operation have different shapes", () => {
    const operations = [op("op-m", "agent", 2)];
    const hunks = [hunk("h-ins", ["op-m"]), hunk("h-del", ["op-m"], "gone")];
    const positions = new Map<string, HunkPositionRange>([
      ["h-ins", range(10, 20)],
      ["h-del", { from: 30, to: 30, hasDeletion: true }],
    ]);
    const [entry] = orderOperationsForSidebar(operations, hunks, positions);
    expect(entry?.shape).toBe("mixed");
  });
});

describe("groupAdjacentEntries", () => {
  // Only firstPos is read by the grouper — the rest of OrderedOperation is
  // present in real usage but irrelevant here, so we cast through unknown to
  // keep the fixture minimal.
  const entries = [
    { firstPos: 5 },
    { firstPos: 15 },
    { firstPos: 40 },
    { firstPos: 55 },
  ] as unknown as Parameters<typeof groupAdjacentEntries>[0];

  it("returns one group per entry when no block resolver is supplied", () => {
    const groups = groupAdjacentEntries(entries, null);
    expect(groups).toHaveLength(entries.length);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1, 1]);
  });

  it("groups entries whose first positions share a block key", () => {
    // First two entries live in block 0; next two live in blocks 10 and 20.
    const groups = groupAdjacentEntries(entries, (pos) => {
      if (pos < 20) return 0;
      if (pos < 50) return 10;
      return 20;
    });
    expect(groups.map((g) => g.map((e) => e.firstPos))).toEqual([[5, 15], [40], [55]]);
  });
});
