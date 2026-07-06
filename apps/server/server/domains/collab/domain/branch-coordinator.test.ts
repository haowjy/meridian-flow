/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
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
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(input.doc),
    stateVector: Y.encodeStateVector(input.doc),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  };
}

class MemoryBranchStore implements BranchStore {
  readonly branches = new Map<string, BranchSnapshot>();
  readonly journal: Uint8Array[] = [];
  failNextCas = false;
  failNextJournal = false;

  async getBranch(branchId: string): Promise<BranchSnapshot | null> {
    return this.branches.get(branchId) ?? null;
  }

  async updateBranchSnapshot(input: {
    branchId: string;
    expectedGeneration: number;
    expectedStateVector: Uint8Array;
    expectedState: Uint8Array;
    state: Uint8Array;
    stateVector: Uint8Array;
  }): Promise<boolean> {
    return this.persist(input, (current) => ({
      ...current,
      state: input.state,
      stateVector: input.stateVector,
    }));
  }

  async resetBranchSnapshot(input: {
    branchId: string;
    expectedGeneration: number;
    expectedStateVector: Uint8Array;
    expectedState: Uint8Array;
    state: Uint8Array;
    stateVector: Uint8Array;
    schemaVersion: number;
  }): Promise<boolean> {
    return this.persist(input, (current) => ({
      ...current,
      generation: current.generation + 1,
      state: input.state,
      stateVector: input.stateVector,
      schemaVersion: input.schemaVersion,
    }));
  }

  private persist(
    input: {
      branchId: string;
      expectedGeneration: number;
      expectedStateVector?: Uint8Array;
      expectedState?: Uint8Array;
    },
    next: (current: BranchSnapshot) => BranchSnapshot,
  ): boolean {
    if (this.failNextCas) {
      this.failNextCas = false;
      return false;
    }
    const current = this.branches.get(input.branchId);
    if (!current || current.generation !== input.expectedGeneration) return false;
    if (input.expectedStateVector && !bytesEqual(current.stateVector, input.expectedStateVector)) {
      return false;
    }
    if (input.expectedState && !bytesEqual(current.state, input.expectedState)) {
      return false;
    }
    this.branches.set(input.branchId, next(current));
    return true;
  }

  async commitBranchMutation(input: {
    branchId: string;
    expectedGeneration: number;
    expectedState?: Uint8Array;
    state: Uint8Array;
    stateVector: Uint8Array;
    journal?: { updateData: Uint8Array };
  }): Promise<boolean> {
    const previousBranch = this.branches.get(input.branchId);
    const ok = this.persist(input, (current) => ({
      ...current,
      state: input.state,
      stateVector: input.stateVector,
    }));
    if (!ok) return false;
    if (this.failNextJournal) {
      this.failNextJournal = false;
      if (previousBranch) this.branches.set(input.branchId, previousBranch);
      throw new Error("injected journal failure");
    }
    if (input.journal) this.journal.push(input.journal.updateData);
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

  it("persists delete-set-only pulls even when the state vector is unchanged", async () => {
    const store = new MemoryBranchStore();
    const live = docWithText("live prose");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: live }));

    live.getText("content").delete(0, 5);
    const before = storedBranch(store, "work");
    expect(Y.encodeStateVector(live)).toEqual(before.stateVector);

    const coordinator = createBranchCoordinator({ store });
    await coordinator.pullFromDoc("work", live);

    expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(live));
  });

  it("journals raw multi-range delete-set updates so replay reaches byte-identical state", async () => {
    const store = new MemoryBranchStore();
    const base = docWithText("abcdef");
    const workDoc = materialize(branchSnapshot({ branchId: "base", doc: base }));
    workDoc.getText("content").delete(2, 1);
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: workDoc }));
    const beforeWork = storedBranch(store, "work");

    const sourceDoc = materialize(beforeWork);
    sourceDoc.getText("content").delete(1, 1);
    sourceDoc.getText("content").delete(2, 1);

    const coordinator = createBranchCoordinator({ store });
    await expect(
      coordinator.commitSyncFromDoc({
        branchId: "work",
        sourceDoc,
        source: "agent",
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(true);

    expect(store.journal).toHaveLength(1);
    const decoded = Y.decodeUpdate(store.journal[0]);
    expect(decoded.structs).toHaveLength(0);
    expect([...decoded.ds.clients.values()].flat().length).toBeGreaterThanOrEqual(2);

    const replayed = materialize(beforeWork);
    Y.applyUpdate(replayed, store.journal[0]);

    expect(replayed.getText("content").toString()).toBe("adf");
    expect(Y.encodeStateAsUpdate(replayed)).toEqual(Y.encodeStateAsUpdate(sourceDoc));
    expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
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

  it("resets from upstream by recreating state, incrementing generation, and carrying schema version", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", {
      ...branchSnapshot({ branchId: "work", doc: docWithText("fresh upstream") }),
      schemaVersion: COLLAB_SCHEMA_VERSION + 1,
    });
    store.branches.set(
      "thread",
      branchSnapshot({
        branchId: "thread",
        doc: docWithText("old peer"),
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );

    const coordinator = createBranchCoordinator({ store });
    await coordinator.resetFromBranch("thread");

    const thread = storedBranch(store, "thread");
    expect(thread.generation).toBe(2);
    expect(thread.schemaVersion).toBe(COLLAB_SCHEMA_VERSION + 1);
    expect(materialize(thread).getText("content").toString()).toBe("fresh upstream");
  });

  it("rejects reset after a delete-only concurrent write changes bytes without changing the state vector", async () => {
    const store = new MemoryBranchStore();
    const originalDoc = docWithText("abcdef");
    const original = branchSnapshot({ branchId: "work", doc: originalDoc });
    store.branches.set("work", original);

    const deleteOnlyDoc = materialize(original);
    deleteOnlyDoc.getText("content").delete(1, 2);
    expect(Y.encodeStateVector(deleteOnlyDoc)).toEqual(original.stateVector);
    store.branches.set("work", {
      ...original,
      state: Y.encodeStateAsUpdate(deleteOnlyDoc),
      stateVector: Y.encodeStateVector(deleteOnlyDoc),
    });

    const coordinator = createBranchCoordinator({ store });
    await expect(
      coordinator.resetFromDocIfUnchanged({
        branchId: "work",
        upstream: docWithText("fresh live"),
        expectedGeneration: original.generation,
        expectedStateVector: original.stateVector,
        expectedState: original.state,
        schemaVersion: original.schemaVersion,
      }),
    ).resolves.toBe(false);

    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("adef");
    expect(store.journal).toHaveLength(0);
  });

  it("resets a work draft only when the caller's snapshot is still current", async () => {
    const store = new MemoryBranchStore();
    const original = branchSnapshot({ branchId: "work", doc: docWithText("old branch") });
    store.branches.set("work", original);
    const coordinator = createBranchCoordinator({ store });

    await expect(
      coordinator.resetFromDocIfUnchanged({
        branchId: "work",
        upstream: docWithText("fresh live"),
        expectedGeneration: original.generation,
        expectedStateVector: original.stateVector,
        expectedState: original.state,
        schemaVersion: original.schemaVersion,
      }),
    ).resolves.toBe(true);
    expect(storedBranch(store, "work").generation).toBe(2);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe(
      "fresh live",
    );

    const current = storedBranch(store, "work");
    await expect(
      coordinator.resetFromDocIfUnchanged({
        branchId: "work",
        upstream: docWithText("stale reset must not win"),
        expectedGeneration: original.generation,
        expectedStateVector: original.stateVector,
        expectedState: original.state,
        schemaVersion: original.schemaVersion,
      }),
    ).resolves.toBe(false);
    expect(storedBranch(store, "work").generation).toBe(current.generation);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe(
      "fresh live",
    );
  });

  it("rejects reset from a non-work-draft upstream", async () => {
    const store = new MemoryBranchStore();
    store.branches.set(
      "thread",
      branchSnapshot({
        branchId: "thread",
        doc: docWithText("old peer"),
        kind: "thread_peer",
        upstreamBranchId: "other-thread",
      }),
    );
    store.branches.set(
      "other-thread",
      branchSnapshot({
        branchId: "other-thread",
        doc: docWithText("not a work draft"),
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );

    const coordinator = createBranchCoordinator({ store });
    await expect(coordinator.resetFromBranch("thread")).rejects.toThrow(/same-document work draft/);
  });

  it("rejects reset when the target or upstream is closed", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("closed-work", {
      ...branchSnapshot({ branchId: "closed-work", doc: docWithText("closed live") }),
      status: "closed",
    });
    store.branches.set(
      "thread",
      branchSnapshot({
        branchId: "thread",
        doc: docWithText("old peer"),
        kind: "thread_peer",
        upstreamBranchId: "closed-work",
      }),
    );
    const coordinator = createBranchCoordinator({ store });

    await expect(coordinator.resetFromBranch("thread")).rejects.toThrow(
      /active same-document work draft/,
    );

    store.branches.set("closed-thread", {
      ...branchSnapshot({
        branchId: "closed-thread",
        doc: docWithText("closed peer"),
        kind: "thread_peer",
        upstreamBranchId: "closed-work",
      }),
      status: "closed",
    });
    await expect(coordinator.resetFromBranch("closed-thread")).rejects.toThrow(
      /active thread peer/,
    );
  });

  it("does not append a journal row when snapshot CAS fails", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));
    store.failNextCas = true;
    const coordinator = createBranchCoordinator({ store, maxCasRetries: 0 });
    const update = Y.encodeStateAsUpdate(docWithText("lost write"));

    await expect(
      coordinator.appendJournaledUpdate({
        branchId: "work",
        generation: 1,
        updateData: update,
        source: "agent",
        threadId: THREAD_ID,
      }),
    ).rejects.toThrow(/changed before/);

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("");
  });

  it("does not mutate the cached branch doc when journal append fails", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));
    const coordinator = createBranchCoordinator({ store });
    const update = Y.encodeStateAsUpdate(docWithText("failed write"));
    store.failNextJournal = true;

    await expect(
      coordinator.appendJournaledUpdate({
        branchId: "work",
        generation: 1,
        updateData: update,
        source: "agent",
        threadId: THREAD_ID,
      }),
    ).rejects.toThrow(/injected journal failure/);

    await coordinator.pullFromDoc("work", new Y.Doc({ gc: false }));
    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("");
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
