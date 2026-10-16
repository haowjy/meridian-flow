/** Branch pull service conformance for live-to-work cadence and the typed outcomes of the rebase. */
import type { DocumentCoordinator } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import { createBranchPullService, DraftRebaseFailedError } from "./branch-pulls.js";
import type { DraftRebase, DraftRebaseOutcome } from "./draft-rebase.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000701" as DocumentId;

/** A lease double: these cases exercise pull cadence, not lease ownership. */
const heldLeases = async (_branchIds: readonly string[], run: (lease: never) => Promise<unknown>) =>
  run(undefined as never);

const NOOP: DraftRebaseOutcome = { kind: "noop", reason: "current" };

/** The service reaches the rebase only through its lease-owned `catchUp`; `catchUp` is the pull. */
function rebaseOf(catchUp: DraftRebase["catchUp"]): { draftRebase: DraftRebase } {
  return { draftRebase: { catchUp } };
}

const inertCoordinator = { withLeases: heldLeases } as unknown as BranchCoordinator;

const noPeers = {
  listActiveWorkDraftBranchIds: async () => ["work"],
  ensureThreadPeerBranch: async () => ({
    branchId: "peer",
    upstreamBranchId: "work",
    state: new Uint8Array(),
  }),
};

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
        branchCoordinator: inertCoordinator,
        ...rebaseOf(async () => {
          if (fail) {
            fail = false;
            throw new Error("pull failed");
          }
          Y.applyUpdate(draft, Y.encodeStateAsUpdate(live));
          return NOOP;
        }),
        branches: noPeers,
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
        branchCoordinator: inertCoordinator,
        ...rebaseOf(async () => {
          if (++pulls === 2) throw new Error("queued pull failed");
          Y.applyUpdate(draft, Y.encodeStateAsUpdate(live));
          return NOOP;
        }),
        branches: noPeers,
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
        branchCoordinator: inertCoordinator,
        ...rebaseOf(async () => {
          if (failures-- > 0) throw new Error("timer pull failed");
          return NOOP;
        }),
        branches: noPeers,
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

  it("fails the pull with the typed reason and does not retry the same inputs", async () => {
    vi.useFakeTimers();
    try {
      const catchUp = vi.fn(
        async (): Promise<DraftRebaseOutcome> => ({ kind: "failed", reason: "merge_failed" }),
      );
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(docWithText("live")),
        branchCoordinator: inertCoordinator,
        ...rebaseOf(catchUp),
        branches: noPeers,
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow(DraftRebaseFailedError);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(catchUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a retry armed while a settlement fences the rebase, and lifts it once the fence clears", async () => {
    vi.useFakeTimers();
    try {
      let fenced = true;
      const catchUp = vi.fn(
        async (): Promise<DraftRebaseOutcome> =>
          fenced ? { kind: "fenced", pushId: 1, state: "pending", ageMs: 0 } : NOOP,
      );
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(docWithText("live")),
        branchCoordinator: inertCoordinator,
        ...rebaseOf(catchUp),
        branches: noPeers,
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      await service.flushLivePull(DOCUMENT_ID);
      expect(vi.getTimerCount()).toBe(1);
      fenced = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(catchUp).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms no retry for a pull that was in flight when shutdown cancelled, and refuses later ones", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred();
      const catchUp = vi.fn(async (): Promise<DraftRebaseOutcome> => {
        await release.promise;
        return { kind: "fenced", pushId: 1, state: "pending", ageMs: 0 };
      });
      const service = createBranchPullService({
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(docWithText("live")),
        branchCoordinator: inertCoordinator,
        ...rebaseOf(catchUp),
        branches: noPeers,
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      const inFlight = service.flushLivePull(DOCUMENT_ID);
      await vi.advanceTimersByTimeAsync(0);
      const closing = service.close();
      release.resolve();
      await inFlight;
      await closing;
      expect(vi.getTimerCount()).toBe(0);
      service.scheduleLivePull(DOCUMENT_ID);
      await service.flushLivePull(DOCUMENT_ID);
      expect(vi.getTimerCount()).toBe(0);
      expect(catchUp).toHaveBeenCalledTimes(1);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
