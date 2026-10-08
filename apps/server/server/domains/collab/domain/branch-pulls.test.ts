/** Branch pull service conformance for live-to-work and work-to-thread cadence. */
import type { DocumentCoordinator } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import { createBranchPullService } from "./branch-pulls.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000701" as DocumentId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

describe("BranchPullService", () => {
  it("keeps the debounce armed after a failed flush and retries the live snapshot", async () => {
    vi.useFakeTimers();
    try {
      const live = docWithText("pending writer edit");
      const draft = new Y.Doc({ gc: false });
      let fail = true;
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(live),
        branchCoordinator: {
          pullFromDoc: async (_branchId: string, upstream: Y.Doc) => {
            if (fail) {
              fail = false;
              throw new Error("pull failed");
            }
            Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
            return emptyYjsUpdate();
          },
        } as unknown as BranchCoordinator,
        branches: {
          listActiveWorkDraftBranchIds: async () => ["work"],
          ensureWorkDraftBranch: async () => ({ branchId: "work" }),
          ensureThreadPeerBranch: async () => ({ branchId: "peer" }),
        },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow("pull failed");
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(draft.getText("content").toString()).toBe("pending writer edit");
      expect(vi.getTimerCount()).toBe(0);
      draft.destroy();
      live.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps newer-update timers armed when a queued pull fails after an older pull commits", async () => {
    vi.useFakeTimers();
    const live = docWithText("old");
    const draft = new Y.Doc({ gc: false });
    try {
      const captured = deferred();
      const commit = deferred();
      let pulls = 0;
      let firstTransaction = true;
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: async (operation) => {
          const result = await operation();
          if (firstTransaction) {
            firstTransaction = false;
            captured.resolve();
            await commit.promise;
          }
          return result;
        },
        liveCoordinator: coordinatorFor(live),
        branchCoordinator: {
          pullFromDoc: async (_branchId: string, upstream: Y.Doc) => {
            if (++pulls === 2) throw new Error("queued pull failed");
            Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
            return emptyYjsUpdate();
          },
        } as unknown as BranchCoordinator,
        branches: {
          listActiveWorkDraftBranchIds: async () => ["work"],
          ensureWorkDraftBranch: async () => ({ branchId: "work" }),
          ensureThreadPeerBranch: async () => ({ branchId: "peer" }),
        },
        diagnostics: { backgroundFailed: () => {} },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      const older = service.flushLivePull(DOCUMENT_ID);
      await captured.promise;
      live.getText("content").insert(3, " and newer");
      service.scheduleLivePull(DOCUMENT_ID);
      const queued = expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow(
        "queued pull failed",
      );
      commit.resolve();
      await older;
      await queued;
      expect(draft.getText("content").toString()).toBe("old");
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(draft.getText("content").toString()).toBe("old and newer");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      live.destroy();
      draft.destroy();
      vi.useRealTimers();
    }
  });

  it("reports timer failures and rearms the maximum debounce for later updates", async () => {
    vi.useFakeTimers();
    try {
      const failed = vi.fn();
      let failures = 2;
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(docWithText("writer edit")),
        branchCoordinator: {
          pullFromDoc: async () => {
            if (failures-- > 0) throw new Error("timer pull failed");
            return emptyYjsUpdate();
          },
        } as unknown as BranchCoordinator,
        branches: {
          listActiveWorkDraftBranchIds: async () => ["work"],
          ensureWorkDraftBranch: async () => ({ branchId: "work" }),
          ensureThreadPeerBranch: async () => ({ branchId: "peer" }),
        },
        diagnostics: { backgroundFailed: failed },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await vi.advanceTimersByTimeAsync(50);
      expect(failed).toHaveBeenCalledTimes(2);
      service.scheduleLivePull(DOCUMENT_ID);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
function coordinatorFor(doc: Y.Doc): DocumentCoordinator {
  return {
    withDocument: async (_documentId, fn) => fn(doc),
    recover: async () => {},
  };
}

function emptyYjsUpdate(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
  } finally {
    doc.destroy();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
