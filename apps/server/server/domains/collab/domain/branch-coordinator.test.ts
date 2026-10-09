/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION, type CollabSchemaVersion } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type BranchSnapshot,
  type BranchStore,
  createBranchCoordinator,
} from "./branch-coordinator.js";
import { PROVENANCE_TARGETS_TYPE } from "./provenance.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000501" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000502" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000503" as ThreadId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

function documentWithReservedFacts(): Y.Doc {
  const doc = docWithText("seed");
  const nested = new Y.Array<unknown>();
  doc.getArray(PROVENANCE_TARGETS_TYPE).push([nested]);
  nested.push(["authority fact"]);
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

  deferUntilCommit(callback: () => void): boolean {
    callback();
    return true;
  }

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
    discardedStateVector: Uint8Array;
    schemaVersion: CollabSchemaVersion;
  }): Promise<boolean> {
    return this.persist(input, (current) => ({
      ...current,
      generation: current.generation + 1,
      state: input.state,
      stateVector: input.stateVector,
      discardedStateVector: input.discardedStateVector,
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
  it("acknowledges already-contained branch writer updates without another journal row", async () => {
    const store = new MemoryBranchStore();
    const branchDoc = docWithText("seed");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: branchDoc }));
    const coordinator = createBranchCoordinator({ store });

    await expect(
      coordinator.commitWriterUpdate({
        branchId: "work",
        expectedGeneration: 1,
        updateData: Y.encodeStateAsUpdate(branchDoc),
        actorUserId: "user-1",
        roomDocument: materialize(storedBranch(store, "work")),
      }),
    ).resolves.toEqual({ admitted: false });

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("seed");
  });

  it("rejects reserved namespace deletion against the snapshot it would commit", async () => {
    const store = new MemoryBranchStore();
    const branchDoc = documentWithReservedFacts();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: branchDoc }));
    const roomDocument = materialize(storedBranch(store, "work"));
    const hostileClient = materialize(storedBranch(store, "work"));
    const before = Y.encodeStateVector(hostileClient);
    hostileClient.getArray(PROVENANCE_TARGETS_TYPE).delete(0, 1);
    const updateData = Y.encodeStateAsUpdate(hostileClient, before);

    const coordinator = createBranchCoordinator({ store });
    await expect(
      coordinator.commitWriterUpdate({
        branchId: "work",
        expectedGeneration: 1,
        updateData,
        actorUserId: "user-1",
        roomDocument,
      }),
    ).rejects.toThrow("reserved provenance");

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getArray(PROVENANCE_TARGETS_TYPE)).toHaveLength(
      1,
    );
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

  it("journals only new multi-range deletions so replay reaches byte-identical state", async () => {
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
        expectedGeneration: beforeWork.generation,
      }),
    ).resolves.toBe(true);

    expect(store.journal).toHaveLength(1);
    const decoded = Y.decodeUpdate(store.journal[0]);
    expect(decoded.structs).toHaveLength(0);
    expect([...decoded.ds.clients.values()].flat()).toEqual([
      { clock: 1, len: 1 },
      { clock: 4, len: 1 },
    ]);

    const replayed = materialize(beforeWork);
    Y.applyUpdate(replayed, store.journal[0]);

    expect(replayed.getText("content").toString()).toBe("adf");
    expect(Y.encodeStateAsUpdate(replayed)).toEqual(Y.encodeStateAsUpdate(sourceDoc));
    expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
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

  it("keeps the discarded replay fence monotonic across resets", async () => {
    const store = new MemoryBranchStore();
    const first = docWithText("first discarded");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: first }));
    const coordinator = createBranchCoordinator({ store });

    await coordinator.resetFromDoc("work", docWithText("second discarded"));
    await coordinator.resetFromDoc("work", docWithText("current"));

    const discarded = Y.decodeStateVector(
      storedBranch(store, "work").discardedStateVector ?? new Uint8Array(),
    );
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(first))) {
      expect(discarded.get(client)).toBeGreaterThanOrEqual(clock);
    }
  });
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
