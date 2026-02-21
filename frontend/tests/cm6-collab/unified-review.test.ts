import { describe, it, expect } from "vitest";
import { editOpsToMergeChanges } from "@/core/cm6-collab/review/ops-to-changes";
import type { ReviewHunk } from "@/core/cm6-collab/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk(
  id: string,
  baseStart: number,
  baseEnd: number,
  deletedText: string,
  insertedText: string,
): ReviewHunk {
  return {
    id,
    proposalId: "p1",
    baseStart,
    baseEnd,
    deletedText,
    insertedText,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// editOpsToMergeChanges
// ---------------------------------------------------------------------------

describe("editOpsToMergeChanges", () => {
  it("returns empty array for no chunks", () => {
    expect(editOpsToMergeChanges([])).toEqual([]);
  });

  it("pure insert: fromA=fromB=baseStart, toA=fromA, toB=fromB+insertLen", () => {
    // base: "hello world" (11 chars), insert " beautiful" at pos 5
    const chunks = [chunk("c0", 5, 5, "", " beautiful")];
    const [change] = editOpsToMergeChanges(chunks);
    expect(change!.fromA).toBe(5);
    expect(change!.toA).toBe(5);
    expect(change!.fromB).toBe(5);
    expect(change!.toB).toBe(15); // 5 + " beautiful".length (10)
  });

  it("pure delete: fromB=toB (no proposed text in range)", () => {
    // base: "hello world", delete " world" (6 chars) at [5, 11)
    const chunks = [chunk("c0", 5, 11, " world", "")];
    const [change] = editOpsToMergeChanges(chunks);
    expect(change!.fromA).toBe(5);
    expect(change!.toA).toBe(11);
    expect(change!.fromB).toBe(5);
    expect(change!.toB).toBe(5); // collapsed
  });

  it("replace: toB = fromB + insertLen", () => {
    // base: "hello world", replace "world" [6,11) with "there"
    const chunks = [chunk("c0", 6, 11, "world", "there")];
    const [change] = editOpsToMergeChanges(chunks);
    expect(change!.fromA).toBe(6);
    expect(change!.toA).toBe(11);
    expect(change!.fromB).toBe(6);
    expect(change!.toB).toBe(11); // 6 + "there".length (5) = 11
  });

  it("tracks offset correctly across multiple chunks (insert then delete)", () => {
    // base: "abcdef"
    // chunk 0: insert "XY" at pos 2 → proposed: "abXYcdef"
    // chunk 1: delete "ef" [4,6) in base → in proposed, [4,6) shifted by +2 → [6,8)
    const chunks = [
      chunk("c0", 2, 2, "", "XY"), // insert, offset becomes +2
      chunk("c1", 4, 6, "ef", ""), // delete 2, offset becomes 0
    ];
    const changes = editOpsToMergeChanges(chunks);
    expect(changes).toHaveLength(2);

    const [ins, del] = changes;
    // Insert
    expect(ins!.fromA).toBe(2);
    expect(ins!.toA).toBe(2);
    expect(ins!.fromB).toBe(2); // 2 + 0 (offset before)
    expect(ins!.toB).toBe(4); // 2 + 2 (insert len)

    // Delete — offset was +2 after insert
    expect(del!.fromA).toBe(4);
    expect(del!.toA).toBe(6);
    expect(del!.fromB).toBe(6); // 4 + 2 (offset)
    expect(del!.toB).toBe(6); // collapsed
  });

  it("no-op chunk (both deleteLen=0 and insertLen=0) is skipped", () => {
    const chunks = [chunk("c0", 3, 3, "", "")];
    expect(editOpsToMergeChanges(chunks)).toHaveLength(0);
  });
});
