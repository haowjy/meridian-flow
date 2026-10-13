/** Retirement maps each cause to a refusal reason and names the peer it retired (contract §2.5). */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createPeerRetirement, type RetiredBranch } from "./peer-retirement.js";

const DOCUMENT = "ch12" as DocumentId;

function retirement() {
  const closeBranchRoom = vi.fn();
  const retireThreadPeers = vi.fn(async () => {});
  return {
    closeBranchRoom,
    retireThreadPeers,
    retire: createPeerRetirement({ closeBranchRoom, agentEdit: { retireThreadPeers } }),
  };
}

describe("peer retirement (U4)", () => {
  it("maps each cause to its refusal reason, by peer", async () => {
    const { retire, retireThreadPeers, closeBranchRoom } = retirement();
    const branches: RetiredBranch[] = [
      { branchId: "p1", documentId: DOCUMENT, threadId: "t1" as ThreadId, cause: "draft_closed" },
      {
        branchId: "p2",
        documentId: DOCUMENT,
        threadId: "t2" as ThreadId,
        cause: "document_discarded",
      },
      { branchId: "p3", documentId: DOCUMENT, threadId: "t3" as ThreadId, cause: "edit_discarded" },
    ];

    await retire(branches);

    expect(closeBranchRoom.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3"]);
    expect(retireThreadPeers).toHaveBeenCalledWith(DOCUMENT, [
      { threadId: "t1", peerBranchId: "p1", reason: "discarded_draft" },
      { threadId: "t2", peerBranchId: "p2", reason: "discarded_document" },
      { threadId: "t3", peerBranchId: "p3", reason: "discarded_edit" },
    ]);
  });

  it("closes the room of a branch with no thread and refuses nothing", async () => {
    const { retire, retireThreadPeers, closeBranchRoom } = retirement();

    await retire([{ branchId: "work-branch", documentId: DOCUMENT, threadId: null }]);

    expect(closeBranchRoom).toHaveBeenCalledWith("work-branch");
    expect(retireThreadPeers).not.toHaveBeenCalled();
  });

  it("retires per document, each peer under its own branch id", async () => {
    const { retire, retireThreadPeers } = retirement();
    const other = "ch13" as DocumentId;

    await retire([
      { branchId: "a", documentId: DOCUMENT, threadId: "t1" as ThreadId, cause: "edit_discarded" },
      { branchId: "b", documentId: other, threadId: "t1" as ThreadId, cause: "edit_discarded" },
    ]);

    expect(retireThreadPeers).toHaveBeenCalledWith(DOCUMENT, [
      { threadId: "t1", peerBranchId: "a", reason: "discarded_edit" },
    ]);
    expect(retireThreadPeers).toHaveBeenCalledWith(other, [
      { threadId: "t1", peerBranchId: "b", reason: "discarded_edit" },
    ]);
  });
});
