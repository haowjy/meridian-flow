/** Branch pull service conformance for live-to-work and work-to-thread cadence. */
import type { DocumentCoordinator } from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import { createBranchPullService } from "./branch-pulls.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000701" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000703" as ThreadId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

describe("BranchPullService", () => {
  it("does not hold the live coordinator lock while acquiring branch locks", async () => {
    let liveLocked = false;
    const service = createBranchPullService({
      liveCoordinator: {
        withDocument: async (_documentId, fn) => {
          liveLocked = true;
          try {
            return await fn(docWithText("live update"));
          } finally {
            liveLocked = false;
          }
        },
        recover: async () => {},
      },
      branchCoordinator: {
        pullFromDoc: async () => {
          expect(liveLocked).toBe(false);
          return emptyYjsUpdate();
        },
        pullFromBranch: async () => {
          expect(liveLocked).toBe(false);
          return emptyYjsUpdate();
        },
        readBranch: async (_branchId: string, fn: Parameters<BranchCoordinator["readBranch"]>[1]) =>
          fn(docWithText("thread"), undefined as never),
      } as unknown as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => ["work"],
        ensureWorkDraftBranch: async () => ({ branchId: "work" }),
        ensureThreadPeerBranch: async () => {
          expect(liveLocked).toBe(false);
          return { branchId: "thread" };
        },
      },
    });

    await service.flushLivePull(DOCUMENT_ID);
    await service.pullThreadPeer({ documentId: DOCUMENT_ID, threadId: THREAD_ID });
  });
  it("flushes live pulls into each active work draft outside the live mutation", async () => {
    const liveDoc = docWithText("live update");
    const pulled: string[] = [];
    const service = createBranchPullService({
      liveCoordinator: coordinatorFor(liveDoc),
      branchCoordinator: {
        pullFromDoc: async (branchId: string, upstream: Y.Doc) => {
          pulled.push(`${branchId}:${upstream.getText("content").toString()}`);
          return emptyYjsUpdate();
        },
      } as unknown as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => ["work-a", "work-b"],
        ensureWorkDraftBranch: async () => ({ branchId: "work" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread" }),
      },
    });

    await service.flushLivePull(DOCUMENT_ID);

    expect(pulled).toEqual(["work-a:live update", "work-b:live update"]);
  });

  it("pulls a thread peer from its work draft through the branch coordinator", async () => {
    const pulled: string[] = [];
    const service = createBranchPullService({
      liveCoordinator: coordinatorFor(docWithText("seed")),
      branchCoordinator: {
        readBranch: async (_branchId: string, fn: Parameters<BranchCoordinator["readBranch"]>[1]) =>
          fn(docWithText("thread"), undefined as never),
        pullFromBranch: async (branchId: string) => {
          pulled.push(branchId);
          return emptyYjsUpdate();
        },
      } as unknown as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => [],
        ensureWorkDraftBranch: async () => ({ branchId: "work" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });

    await service.pullThreadPeer({ documentId: DOCUMENT_ID, threadId: THREAD_ID });

    expect(pulled).toEqual(["thread-peer"]);
  });

  it("returns the captured work-draft generation as the thread-peer write fence", async () => {
    const pulled: string[] = [];
    const service = createBranchPullService({
      liveCoordinator: coordinatorFor(docWithText("seed")),
      branchCoordinator: {
        readBranch: async (
          branchId: string,
          fn: Parameters<BranchCoordinator["readBranch"]>[1],
        ) => {
          if (branchId === "thread-peer") {
            return fn(docWithText("peer before pull"), {
              branchId: "thread-peer",
              generation: 2,
              upstreamBranchId: "work-draft",
            } as never);
          }
          return fn(docWithText("work after human"), {
            branchId: "work-draft",
            generation: 7,
            upstreamBranchId: null,
          } as never);
        },
        pullFromDoc: async (branchId: string, upstream: Y.Doc) => {
          pulled.push(`${branchId}:${upstream.getText("content").toString()}`);
          return Y.encodeStateAsUpdate(upstream);
        },
        pullFromBranch: async () => {
          throw new Error("pullThreadPeer should pull from the captured upstream snapshot");
        },
      } as unknown as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => [],
        ensureWorkDraftBranch: async () => ({ branchId: "work-draft" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });

    const result = await service.pullThreadPeer({ documentId: DOCUMENT_ID, threadId: THREAD_ID });

    expect(result.branchGeneration).toBe(7);
    expect(result.changed).toBe(true);
    expect(pulled).toEqual(["thread-peer:work after human"]);
  });

  it("reports unchanged when the pull only carries an already-applied delete set", async () => {
    const tombstoneDoc = tombstoneBearingDoc();
    const baseline = Y.encodeStateAsUpdate(tombstoneDoc);
    let capturedBaseline = false;
    const service = createBranchPullService({
      liveCoordinator: coordinatorFor(docWithText("seed")),
      branchCoordinator: {
        readBranch: async (_branchId: string, fn: Parameters<BranchCoordinator["readBranch"]>[1]) =>
          fn(tombstoneDoc, undefined as never),
        pullFromBranch: async () =>
          Y.encodeStateAsUpdate(tombstoneDoc, Y.encodeStateVector(tombstoneDoc)),
      } as unknown as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => [],
        ensureWorkDraftBranch: async () => ({ branchId: "work" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });

    const result = await service.pullThreadPeer({ documentId: DOCUMENT_ID, threadId: THREAD_ID });
    capturedBaseline = result.baselineSnapshot !== undefined;

    expect(Y.encodeStateAsUpdate(tombstoneDoc)).toEqual(baseline);
    expect(result.changed).toBe(false);
    expect(capturedBaseline).toBe(false);
  });
});

function tombstoneBearingDoc(): Y.Doc {
  const doc = docWithText("seed");
  doc.getText("content").delete(1, 1);
  return doc;
}

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
