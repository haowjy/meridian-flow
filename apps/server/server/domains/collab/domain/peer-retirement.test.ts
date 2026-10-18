/** Retirement maps each cause to a refusal reason and names the peer it retired (contract §2.5). */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createPeerRetirement, type RetiredDraft } from "./peer-retirement.js";

const DOCUMENT = "ch12" as DocumentId;

function retirement() {
  const closeDraftRoom = vi.fn();
  const retireThreadPeers = vi.fn(async () => {});
  return {
    closeDraftRoom,
    retireThreadPeers,
    retire: createPeerRetirement({ closeDraftRoom, agentEdit: { retireThreadPeers } }),
  };
}

describe("peer retirement (U4)", () => {
  it("maps each cause to its refusal reason, by peer", async () => {
    const { retire, retireThreadPeers, closeDraftRoom } = retirement();
    const drafts: RetiredDraft[] = [
      { draftId: "p1", documentId: DOCUMENT, threadId: "t1" as ThreadId, cause: "branch_closed" },
      {
        draftId: "p2",
        documentId: DOCUMENT,
        threadId: "t2" as ThreadId,
        cause: "document_discarded",
      },
      { draftId: "p3", documentId: DOCUMENT, threadId: "t3" as ThreadId, cause: "edit_discarded" },
    ];

    await retire(drafts);

    expect(closeDraftRoom.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3"]);
    expect(retireThreadPeers).toHaveBeenCalledWith(DOCUMENT, [
      { threadId: "t1", peerDraftId: "p1", reason: "discarded_draft" },
      { threadId: "t2", peerDraftId: "p2", reason: "discarded_document" },
      { threadId: "t3", peerDraftId: "p3", reason: "discarded_edit" },
    ]);
  });

  it("closes the room of a branch with no thread and refuses nothing", async () => {
    const { retire, retireThreadPeers, closeDraftRoom } = retirement();

    await retire([{ draftId: "work-branch", documentId: DOCUMENT, threadId: null }]);

    expect(closeDraftRoom).toHaveBeenCalledWith("work-branch");
    expect(retireThreadPeers).not.toHaveBeenCalled();
  });

  it("retires per document, each peer under its own branch id", async () => {
    const { retire, retireThreadPeers } = retirement();
    const other = "ch13" as DocumentId;

    await retire([
      { draftId: "a", documentId: DOCUMENT, threadId: "t1" as ThreadId, cause: "edit_discarded" },
      { draftId: "b", documentId: other, threadId: "t1" as ThreadId, cause: "edit_discarded" },
    ]);

    expect(retireThreadPeers).toHaveBeenCalledWith(DOCUMENT, [
      { threadId: "t1", peerDraftId: "a", reason: "discarded_edit" },
    ]);
    expect(retireThreadPeers).toHaveBeenCalledWith(other, [
      { threadId: "t1", peerDraftId: "b", reason: "discarded_edit" },
    ]);
  });
});
