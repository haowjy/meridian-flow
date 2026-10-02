/** Transaction publication contracts for effective document membership. */

import { describe, expect, it, vi } from "vitest";
import { createEffectiveDocumentReader } from "./effective-document-reader.js";

describe("effective document reader manifest publication", () => {
  it("defers an automatic manifest push until the enclosing transaction commits", async () => {
    const deferred: Array<() => void | Promise<void>> = [];
    const recordManifestDocumentCreated = vi.fn().mockResolvedValue({
      workDraftBranchId: "branch-manifest",
      policy: "auto",
    });
    const pushAutoBranchAfterThreadPeerWrite = vi.fn().mockResolvedValue({ status: "pushed" });
    const reader = createEffectiveDocumentReader({
      branches: { recordManifestDocumentCreated } as never,
      branchCoordinator: {} as never,
      branchPulls: {} as never,
      branchPush: { pushAutoBranchAfterThreadPeerWrite },
      liveCoordinator: {} as never,
      agentEdit: {} as never,
      documents: {} as never,
      model: {} as never,
      codec: {} as never,
      deferUntilCommit(callback) {
        deferred.push(callback);
        return true;
      },
    });

    await reader.recordManifestDocumentCreated("00000000-0000-4000-8000-000000000355" as never, {
      projectId: "00000000-0000-4000-8000-000000000356" as never,
      threadId: "00000000-0000-4000-8000-000000000357" as never,
    });

    expect(recordManifestDocumentCreated).toHaveBeenCalledOnce();
    expect(pushAutoBranchAfterThreadPeerWrite).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    await deferred[0]?.();

    expect(pushAutoBranchAfterThreadPeerWrite).toHaveBeenCalledWith({
      workDraftBranchId: "branch-manifest",
    });
  });
});

describe("effective document reader destinations (D40)", () => {
  function reader() {
    const branches = {
      resolveThreadBranch: vi.fn(),
      resolveWorkDraftBranchForThread: vi.fn(),
    };
    const branchPulls = { pullThreadPeer: vi.fn(), flushLivePull: vi.fn() };
    const readVersionedMarkdown = vi.fn(async () => ({
      ok: true as const,
      value: { content: "Live text.", revision: "y1:live" },
    }));
    const effective = createEffectiveDocumentReader({
      branches: branches as never,
      branchCoordinator: {} as never,
      branchPulls: branchPulls as never,
      branchPush: {} as never,
      liveCoordinator: {} as never,
      agentEdit: {
        responseDocuments: () => ({ staged: [], created: [] }),
        hasResponseDocument: () => false,
      } as never,
      documents: { readVersionedMarkdown } as never,
      model: {} as never,
      codec: {} as never,
    });
    return { effective, branches, branchPulls, readVersionedMarkdown };
  }

  it("reads live without touching a kept Work draft when the thread writes live", async () => {
    const { effective, branches, branchPulls, readVersionedMarkdown } = reader();

    const read = await effective.readEffectiveMarkdown({
      documentId: "00000000-0000-4000-8000-000000000358" as never,
      threadId: "00000000-0000-4000-8000-000000000357" as never,
      destination: "live",
    });

    expect(read).toEqual({ ok: true, value: { content: "Live text.", revision: "y1:live" } });
    expect(readVersionedMarkdown).toHaveBeenCalledOnce();
    expect(branches.resolveThreadBranch).not.toHaveBeenCalled();
    expect(branches.resolveWorkDraftBranchForThread).not.toHaveBeenCalled();
    expect(branchPulls.pullThreadPeer).not.toHaveBeenCalled();
    expect(branchPulls.flushLivePull).not.toHaveBeenCalled();
  });
});
