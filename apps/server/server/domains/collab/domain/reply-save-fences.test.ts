/** The reply save fence: identity admission and reasoned refusal (contract §2.1). */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createFakeDraftTable,
  createFakeFileAccess,
  createFakeThreadPeerCores,
  FAKE_BRANCH_ID,
  FAKE_UPSTREAM_ID,
  fakeEditGrant,
} from "../test-support/thread-peer-pool-fakes.js";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createReplySaveFences, type ReplyRecord } from "./reply-save-fences.js";

const DOCUMENT = "ch12" as DocumentId;
const THREAD = "thread-1" as ThreadId;
const WORK = "work-a" as WorkId;

function scenario() {
  const { liveCore, threadCore } = createFakeThreadPeerCores();
  const live = asLiveAgentEditCore(liveCore.asCore());
  const drafts = createFakeDraftTable({ documentId: DOCUMENT, threadId: THREAD });
  const branches = {
    shareActive: vi.fn(async (_id: BranchId) => ({ id: FAKE_BRANCH_ID }) as never),
  };
  const fileAccess = createFakeFileAccess();
  const diagnostics = { replyPinMismatch: vi.fn() };
  const fences = createReplySaveFences({
    liveUtilityCore: live,
    drafts,
    branches,
    diagnostics,
    fileAccess,
    removals: { lookup: async () => new Map() },
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  const core = threadCore.asCore();
  const record: ReplyRecord = {
    responseId: "reply-1",
    threadId: THREAD,
    participants: new Set([core]),
    receipting: new Set(),
    documents: new Map([
      [
        DOCUMENT,
        {
          core,
          grant: fakeEditGrant({ kind: "draft", workId: WORK, workSlug: "a" }),
          linkView: { kind: "branch", branchId: FAKE_BRANCH_ID },
          pin: {
            branchId: FAKE_BRANCH_ID,
            peerDraftId: "peer-1",
            upstreamDraftId: FAKE_UPSTREAM_ID,
          },
        },
      ],
    ]),
  };
  return {
    fences,
    record,
    drafts,
    branches,
    fileAccess,
    threadCore,
    diagnostics,
  };
}

describe("reply save fence", () => {
  it("admits a pin whose branch, upstream and peer all stand", async () => {
    const { fences, record, threadCore } = scenario();
    await expect(fences.confirm(record)).resolves.toEqual([]);
    expect(threadCore.refuseStaged).not.toHaveBeenCalled();
    expect(record.documents.has(DOCUMENT)).toBe(true);
  });

  it.each([
    [
      "branch closed",
      (s: ReturnType<typeof scenario>) => s.branches.shareActive.mockResolvedValue(null as never),
      "discarded_draft",
    ],
    [
      "upstream closed",
      (s: ReturnType<typeof scenario>) => s.drafts.close(FAKE_UPSTREAM_ID),
      "discarded_document",
    ],
    ["peer closed", (s: ReturnType<typeof scenario>) => s.drafts.close("peer-1"), "discarded_edit"],
  ] as const)("refuses with the reason the branch, upstream draft or peer draft state names: %s", async (_name, arrange, reason) => {
    const s = scenario();
    arrange(s);

    const refused = await s.fences.confirm(s.record);

    expect(refused).toEqual([{ documentId: DOCUMENT, reason }]);
    expect(s.threadCore.refuseStaged).toHaveBeenCalledWith("reply-1", DOCUMENT, reason, "peer-1");
    expect(s.record.documents.has(DOCUMENT)).toBe(false);
    expect(s.record.receipting.size).toBe(1);
    expect(s.record.participants.size).toBe(1);
  });

  it("a vanished upstream or peer refuses with the reason a closed one does", async () => {
    const gone = scenario();
    gone.drafts.set(FAKE_UPSTREAM_ID, null);
    await expect(gone.fences.confirm(gone.record)).resolves.toEqual([
      { documentId: DOCUMENT, reason: "discarded_document" },
    ]);
    const lost = scenario();
    lost.drafts.set("peer-1", null);
    await expect(lost.fences.confirm(lost.record)).resolves.toEqual([
      { documentId: DOCUMENT, reason: "discarded_edit" },
    ]);
  });

  it("the branch's closure outranks a closed upstream and a closed peer", async () => {
    const s = scenario();
    s.branches.shareActive.mockResolvedValue(null as never);
    s.drafts.close(FAKE_UPSTREAM_ID);
    s.drafts.close("peer-1");
    await expect(s.fences.confirm(s.record)).resolves.toEqual([
      { documentId: DOCUMENT, reason: "discarded_draft" },
    ]);
  });

  it("reports an invariant break and refuses as integration for a peer in another branch", async () => {
    const s = scenario();
    s.drafts.set("peer-1", {
      ...(await s.drafts.getDraft("peer-1"))!,
      branchId: "another-branch" as BranchId,
    } as never);

    await expect(s.fences.confirm(s.record)).resolves.toEqual([
      { documentId: DOCUMENT, reason: "integration" },
    ]);
    expect(s.diagnostics.replyPinMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOCUMENT, threadId: THREAD }),
    );
  });

  it("a denied grant drops the document's writes with the policy's copy and keeps no receipt owner", async () => {
    const s = scenario();
    const denial = { target: { kind: "document", documentId: DOCUMENT }, reason: "archived" };
    s.fileAccess.confirmEdit = vi.fn(async () => [denial]) as never;

    const refused = await s.fences.confirm(s.record);

    expect(refused).toEqual([{ documentId: DOCUMENT, denial }]);
    expect(s.threadCore.dropStaged).toHaveBeenCalledWith(DOCUMENT, THREAD);
    expect(s.threadCore.refuseStaged).not.toHaveBeenCalled();
    expect(s.record.participants.size).toBe(0);
  });
});
