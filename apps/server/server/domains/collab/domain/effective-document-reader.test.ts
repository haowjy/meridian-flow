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
