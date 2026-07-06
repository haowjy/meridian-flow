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
          return new Uint8Array();
        },
        pullFromBranch: async () => {
          expect(liveLocked).toBe(false);
          return new Uint8Array();
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
        pullFromDoc: async (branchId, upstream) => {
          pulled.push(`${branchId}:${upstream.getText("content").toString()}`);
          return new Uint8Array();
        },
      } as BranchCoordinator,
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
        pullFromBranch: async (branchId) => {
          pulled.push(branchId);
          return new Uint8Array();
        },
      } as BranchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => [],
        ensureWorkDraftBranch: async () => ({ branchId: "work" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });

    await service.pullThreadPeer({ documentId: DOCUMENT_ID, threadId: THREAD_ID });

    expect(pulled).toEqual(["thread-peer"]);
  });
});

function coordinatorFor(doc: Y.Doc): DocumentCoordinator {
  return {
    withDocument: async (_documentId, fn) => fn(doc),
    recover: async () => {},
  };
}
