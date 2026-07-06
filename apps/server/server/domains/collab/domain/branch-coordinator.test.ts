/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type BranchSnapshot,
  type BranchStore,
  createBranchCoordinator,
} from "./branch-coordinator.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000501" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000502" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000503" as ThreadId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

function branchSnapshot(input: {
  branchId: string;
  doc: Y.Doc;
  kind?: "work_draft" | "thread_peer";
  upstreamBranchId?: string | null;
}): BranchSnapshot {
  return {
    branchId: input.branchId,
    documentId: DOCUMENT_ID,
    kind: input.kind ?? "work_draft",
    upstreamBranchId: input.upstreamBranchId ?? null,
    workId: WORK_ID,
    threadId: input.kind === "thread_peer" ? THREAD_ID : null,
    pushPolicy: "manual",
    generation: 1,
    state: Y.encodeStateAsUpdate(input.doc),
    stateVector: Y.encodeStateVector(input.doc),
  };
}

class MemoryBranchStore implements BranchStore {
  readonly branches = new Map<string, BranchSnapshot>();
  readonly journal: Uint8Array[] = [];
  failNextCas = false;

  async getBranch(branchId: string): Promise<BranchSnapshot | null> {
    return this.branches.get(branchId) ?? null;
  }

  async updateBranchSnapshot(input: {
    branchId: string;
    expectedGeneration: number;
    expectedStateVector: Uint8Array;
    state: Uint8Array;
    stateVector: Uint8Array;
  }): Promise<boolean> {
    if (this.failNextCas) {
      this.failNextCas = false;
      return false;
    }
    const current = this.branches.get(input.branchId);
    if (!current || current.generation !== input.expectedGeneration) return false;
    this.branches.set(input.branchId, {
      ...current,
      state: input.state,
      stateVector: input.stateVector,
    });
    return true;
  }

  async appendJournal(input: { updateData: Uint8Array }): Promise<void> {
    this.journal.push(input.updateData);
  }
}

function storedBranch(store: MemoryBranchStore, branchId: string): BranchSnapshot {
  const snapshot = store.branches.get(branchId);
  if (!snapshot) throw new Error(`Missing branch ${branchId}`);
  return snapshot;
}

function materialize(snapshot: BranchSnapshot): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, snapshot.state);
  return doc;
}

describe("BranchCoordinator", () => {
  it("pulls live edits into a work draft using sync and persists byte-equal state", async () => {
    const store = new MemoryBranchStore();
    const live = docWithText("live prose");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));

    const coordinator = createBranchCoordinator({ store });
    await coordinator.pullFromDoc("work", live);

    const work = materialize(storedBranch(store, "work"));
    expect(Y.encodeStateAsUpdate(work)).toEqual(Y.encodeStateAsUpdate(live));
  });

  it("pulls a work draft into a thread peer", async () => {
    const store = new MemoryBranchStore();
    const workDoc = docWithText("draft prose");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: workDoc }));
    store.branches.set(
      "thread",
      branchSnapshot({
        branchId: "thread",
        doc: new Y.Doc({ gc: false }),
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );

    const coordinator = createBranchCoordinator({ store });
    await coordinator.pullFromBranch("thread");

    const thread = materialize(storedBranch(store, "thread"));
    expect(Y.encodeStateAsUpdate(thread)).toEqual(Y.encodeStateAsUpdate(workDoc));
  });

  it("aborts and retries the whole mutation on CAS failure", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));
    store.failNextCas = true;
    const coordinator = createBranchCoordinator({ store, maxCasRetries: 1 });

    await coordinator.pullFromDoc("work", docWithText("after retry"));

    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe(
      "after retry",
    );
  });

  it("applies journaled synthetic writes under the branch lock", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));
    const updateDoc = docWithText("journal write");
    const update = Y.encodeStateAsUpdate(updateDoc);

    const coordinator = createBranchCoordinator({ store });
    await coordinator.appendJournaledUpdate({
      branchId: "work",
      generation: 1,
      updateData: update,
      source: "agent",
      threadId: THREAD_ID,
    });

    expect(store.journal).toHaveLength(1);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe(
      "journal write",
    );
  });
});
