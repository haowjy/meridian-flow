/** Public-seam coverage for folding branch-local reversal history. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { activeBranchAgentWriteRows } from "./branch-reversal-history.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;

describe("activeBranchAgentWriteRows", () => {
  it("squashes undone handles and retains redone handles regardless of row order", () => {
    const row = (id: number, wId: number | null, updateMeta?: unknown) => ({
      id,
      branchId: "work",
      generation: 1,
      wId,
      source: "agent" as const,
      threadId: THREAD_ID,
      turnId: null,
      actorUserId: null,
      updateData: new Uint8Array([id]),
      draftBaseUpdateSeq: 1,
      status: "pushed" as const,
      updateMeta,
    });
    const forward = [row(1, 1), row(2, 2)];
    const undo = row(3, null, {
      origin: "system",
      seq: 0,
      branchReversal: {
        direction: "undo",
        records: [
          {
            documentId: "chapter.md",
            threadId: THREAD_ID,
            turnId: null,
            writeIds: ["w1"],
            status: "reversed",
          },
        ],
      },
    });

    expect(activeBranchAgentWriteRows([...forward, undo]).map(({ wId }) => wId)).toEqual([2]);
    expect(activeBranchAgentWriteRows([undo, ...forward]).map(({ wId }) => wId)).toEqual([2]);
    expect(
      activeBranchAgentWriteRows([
        ...forward,
        undo,
        row(4, null, {
          origin: "system",
          seq: 0,
          branchReversal: {
            direction: "redo",
            refs: [{ threadId: THREAD_ID, undoUpdateSeq: 3 }],
          },
        }),
      ]).map(({ wId }) => wId),
    ).toEqual([1, 2]);
  });
});
