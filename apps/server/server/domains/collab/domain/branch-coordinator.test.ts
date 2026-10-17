/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { allocateDocumentClient, COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import {
  commitJournaledUpdate,
  commitSegmentRows,
  resetBranchFromDoc,
} from "../test-support/branch-update-writes.js";
import { captureHistoricalBranchRow } from "../test-support/historical-branch-row.js";
import {
  type AppendBranchJournalInput,
  type AppendRowsInput,
  type AppendRowsOutcome,
  type BranchRead,
  type BranchReadSince,
  type BranchSnapshot,
  type BranchStore,
  type CommitRewriteInput,
  createBranchCoordinator,
  mergeStateVectors,
  type RewriteOutcome,
} from "./branch-coordinator.js";
import { BranchLeaseScopeError, createBranchCriticalSections } from "./branch-critical-sections.js";
import { PROVENANCE_TARGETS_TYPE } from "./provenance.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000501" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000502" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000503" as ThreadId;

/** A pull under the one-branch lease a caller takes before its transaction. */
function pull(
  coordinator: ReturnType<typeof createBranchCoordinator>,
  branchId: string,
  upstream: Y.Doc,
) {
  return coordinator.withLeases([branchId], (lease) =>
    coordinator.pullFromDoc(lease, branchId, upstream),
  );
}

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

function documentWithReservedFacts(): Y.Doc {
  const doc = docWithText("seed");
  const nested = new Y.Array<unknown>();
  doc.getMap(PROVENANCE_TARGETS_TYPE).set("nested", nested);
  nested.push(["authority fact"]);
  return doc;
}

type MemoryRow = { id: number; generation: number; update: Uint8Array; source: "agent" | "writer" };

/** A branch as the store keeps it: the row, its checkpoint and every journal row it has. */
type MemoryBranch = BranchSnapshot & {
  checkpoint: { state: Uint8Array; stateVector: Uint8Array };
  rows: MemoryRow[];
};

/** A branch's materialized content (checkpoint ⊕ tail), for assertions. */
type StoredBranch = MemoryBranch & { state: Uint8Array; stateVector: Uint8Array };

function branchSnapshot(input: {
  branchId: string;
  doc: Y.Doc;
  kind?: "work_draft" | "thread_peer";
  upstreamBranchId?: string | null;
}): MemoryBranch {
  return {
    branchId: input.branchId,
    documentId: DOCUMENT_ID,
    kind: input.kind ?? "work_draft",
    upstreamBranchId: input.upstreamBranchId ?? null,
    draftId: "draft-1",
    workId: WORK_ID,
    threadId: input.kind === "thread_peer" ? THREAD_ID : null,
    status: "active",
    generation: 1,
    revision: 0,
    checkpointRevision: 0,
    checkpointSeq: 0,
    lifecycle: "active",
    hasEffect: false,
    blocking: false,
    schemaVersion: COLLAB_SCHEMA_VERSION,
    checkpoint: {
      state: Y.encodeStateAsUpdate(input.doc),
      stateVector: Y.encodeStateVector(input.doc),
    },
    rows: [],
  };
}

/**
 * The checkpoint + tail store in memory: every committed write bumps `revision`, an append
 * adds tail rows, a rewrite replaces the checkpoint and moves `checkpointSeq` past every row.
 */
class MemoryBranchStore implements BranchStore {
  readonly branches = new Map<string, MemoryBranch>();
  /** Every journal row ever appended, in order. */
  readonly journal: Uint8Array[] = [];
  failNextCas = false;
  failNextJournal = false;
  private nextRowId = 1;

  deferUntilCommit(callback: () => void): boolean {
    callback();
    return true;
  }

  async getBranch(branchId: string): Promise<BranchSnapshot | null> {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    const { checkpoint: _checkpoint, rows: _rows, ...snapshot } = branch;
    return snapshot;
  }

  async readBranchAt(branchId: string, since?: BranchReadSince): Promise<BranchRead | null> {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    const held = since?.checkpointRevision === branch.checkpointRevision;
    const after = held ? Math.max(since.seq, branch.checkpointSeq) : branch.checkpointSeq;
    const snapshot = await this.getBranch(branchId);
    if (!snapshot) return null;
    return {
      branch: snapshot,
      checkpoint: held ? null : branch.checkpoint,
      tail: branch.rows
        .filter((row) => row.generation === branch.generation && row.id > after)
        .map(({ id, update, source }) => ({ id, update, source })),
    };
  }

  async appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const branch = this.branches.get(input.branchId);
    if (this.takeCasFailure() || !branch || !this.writable(branch, input.expectedRevision))
      return { status: "moved" };
    if (branch.generation !== input.expectedGeneration) return { status: "moved" };
    if (this.failNextJournal) {
      this.failNextJournal = false;
      throw new Error("injected journal failure");
    }
    const rowIds = input.rows.map((row) => this.append(branch, row));
    branch.revision += 1;
    return { status: "appended", revision: branch.revision, rowIds };
  }

  async commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    const branch = this.branches.get(input.branchId);
    if (branch?.status !== "active") return { status: "closed" };
    if (this.takeCasFailure()) return { status: "moved" };
    if (
      input.policy.kind === "exact"
        ? branch.revision !== input.policy.revision
        : branch.checkpointRevision !== input.policy.checkpointRevision
    )
      return { status: "moved" };
    const tail = branch.rows.filter(
      (row) => row.generation === branch.generation && row.id > branch.checkpointSeq,
    );
    const { operation } = input;
    // A fold applies what landed after its cursor; a reset discards it.
    if (input.policy.kind === "fold" && operation.kind !== "reset") {
      const after = input.policy.seq;
      for (const row of tail) if (row.id > after) Y.applyUpdate(input.doc, row.update);
    }
    if (operation.kind === "checkpoint")
      for (const row of operation.rows ?? []) this.append(branch, row);
    if (operation.kind === "reset") {
      branch.discardedStateVector = tail.reduce(
        (vector, row) =>
          mergeStateVectors(vector, Y.encodeStateVector(Y.parseUpdateMeta(row.update).to)),
        mergeStateVectors(branch.discardedStateVector, branch.checkpoint.stateVector),
      );
      branch.generation += 1;
      branch.schemaVersion = operation.schemaVersion;
    }
    branch.checkpoint = {
      state: Y.encodeStateAsUpdate(input.doc),
      stateVector: Y.encodeStateVector(input.doc),
    };
    branch.checkpointSeq = Math.max(0, ...branch.rows.map((row) => row.id));
    branch.revision += 1;
    branch.checkpointRevision = branch.revision;
    return {
      status: "committed",
      revision: branch.revision,
      checkpointRevision: branch.checkpointRevision,
      seq: branch.checkpointSeq,
      generation: branch.generation,
    };
  }

  private append(branch: MemoryBranch, row: AppendBranchJournalInput): number {
    const id = this.nextRowId++;
    branch.rows.push({
      id,
      generation: row.generation,
      update: row.updateData,
      source: row.source,
    });
    this.journal.push(row.updateData);
    return id;
  }

  private writable(branch: MemoryBranch, revision: number): boolean {
    return branch.status === "active" && branch.revision === revision;
  }

  private takeCasFailure(): boolean {
    if (!this.failNextCas) return false;
    this.failNextCas = false;
    return true;
  }
}

function storedBranch(store: MemoryBranchStore, branchId: string): StoredBranch {
  const branch = store.branches.get(branchId);
  if (!branch) throw new Error(`Missing branch ${branchId}`);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, branch.checkpoint.state);
  for (const row of branch.rows)
    if (row.generation === branch.generation && row.id > branch.checkpointSeq)
      Y.applyUpdate(doc, row.update);
  return { ...branch, state: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}

function materialize(snapshot: { state: Uint8Array } | MemoryBranch): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, "state" in snapshot ? snapshot.state : snapshot.checkpoint.state);
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
    hostileClient.getMap(PROVENANCE_TARGETS_TYPE).delete("nested");
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
    expect(materialize(storedBranch(store, "work")).getMap(PROVENANCE_TARGETS_TYPE).size).toBe(1);
  });

  it("persists delete-set-only pulls even when the state vector is unchanged", async () => {
    const store = new MemoryBranchStore();
    const live = docWithText("live prose");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: live }));

    live.getText("content").delete(0, 5);
    const before = storedBranch(store, "work");
    expect(Y.encodeStateVector(live)).toEqual(before.stateVector);

    const coordinator = createBranchCoordinator({ store });
    await pull(coordinator, "work", live);

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
      commitSegmentRows(coordinator, {
        branchId: "work",
        sourceDoc: sourceDoc,
        expectedGeneration: beforeWork.generation,
        rows: [
          {
            branchId: "work",
            updateData: await captureHistoricalBranchRow(coordinator, "work", sourceDoc),
            source: "agent",
            threadId: THREAD_ID,
          },
        ],
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

    await pull(coordinator, "work", docWithText("after retry"));

    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe(
      "after retry",
    );
  });

  // Risk: a delete-only write leaves the state vector unchanged; a reset judged before it
  // must not commit over it (the byte compare caught this; the revision must too).
  it("a reset against a moved revision returns moved", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: docWithText("abcdef") }));
    const original = storedBranch(store, "work");

    const deleteOnlyDoc = materialize(original);
    const before = Y.encodeStateVector(deleteOnlyDoc);
    deleteOnlyDoc.getText("content").delete(1, 2);
    expect(Y.encodeStateVector(deleteOnlyDoc)).toEqual(original.stateVector);
    await expect(
      store.appendRows({
        branchId: "work",
        expectedRevision: original.revision,
        expectedGeneration: original.generation,
        rows: [
          {
            branchId: "work",
            generation: original.generation,
            updateData: Y.encodeStateAsUpdate(deleteOnlyDoc, before),
            source: "writer",
          },
        ],
        receiptBase: original.state,
      }),
    ).resolves.toMatchObject({ status: "appended" });

    const coordinator = createBranchCoordinator({ store });
    await expect(
      coordinator.withLeases(["work"], (lease) =>
        coordinator.resetFromDocIfUnchangedWithLease(lease, {
          branchId: "work",
          upstream: docWithText("fresh live"),
          expectedGeneration: original.generation,
          expectedRevision: original.revision,
          schemaVersion: original.schemaVersion,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      store.commitRewrite({
        branchId: "work",
        policy: { kind: "exact", revision: original.revision },
        fence: { kind: "none" },
        doc: docWithText("fresh live"),
        operation: {
          kind: "reset",
          editDisposition: "discarded",
          schemaVersion: original.schemaVersion,
        },
      }),
    ).resolves.toEqual({ status: "moved" });

    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("adef");
    expect(storedBranch(store, "work").generation).toBe(1);
  });

  it("does not mutate the cached branch doc when journal append fails", async () => {
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: new Y.Doc({ gc: false }) }));
    const coordinator = createBranchCoordinator({ store });
    const update = Y.encodeStateAsUpdate(docWithText("failed write"));
    store.failNextJournal = true;

    await expect(
      commitJournaledUpdate(coordinator, {
        branchId: "work",
        updateData: update,
        source: "agent",
        threadId: THREAD_ID,
      }),
    ).rejects.toThrow(/injected journal failure/);

    await pull(coordinator, "work", new Y.Doc({ gc: false }));
    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("");
  });

  it("keeps the discarded replay fence monotonic across resets", async () => {
    const store = new MemoryBranchStore();
    const first = docWithText("first discarded");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: first }));
    const coordinator = createBranchCoordinator({ store });

    await resetBranchFromDoc(coordinator, store, "work", docWithText("second discarded"));
    await resetBranchFromDoc(coordinator, store, "work", docWithText("current"));

    const discarded = Y.decodeStateVector(
      storedBranch(store, "work").discardedStateVector ?? new Uint8Array(),
    );
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(first))) {
      expect(discarded.get(client)).toBeGreaterThanOrEqual(clock);
    }
  });
});

it("publishes ordered segment rows once and rejects reused clients and unjournaled residuals", async () => {
  const store = new MemoryBranchStore();
  const base = docWithText("start");
  store.branches.set("work", branchSnapshot({ branchId: "work", doc: base }));
  const sourceDoc = materialize(storedBranch(store, "work"));
  const rows = [];
  for (let i = 0; i < 40; i++) {
    sourceDoc.clientID = allocateDocumentClient(sourceDoc);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    sourceDoc.on("update", collect);
    sourceDoc.getText("content").insert(sourceDoc.getText("content").length, ` ${i}`);
    sourceDoc.off("update", collect);
    rows.push({
      branchId: "work",
      source: "agent" as const,
      updateData: Y.mergeUpdates(updates),
      toolCallId: i < 20 ? "first" : "second",
      wId: i < 20 ? 1 : 2,
    });
  }
  let broadcasts = 0;
  const coordinator = createBranchCoordinator({ store, onBranchUpdate: () => broadcasts++ });
  await expect(
    commitSegmentRows(coordinator, {
      branchId: "work",
      expectedGeneration: 1,
      sourceDoc,
      rows: rows.slice(0, -1),
    }),
  ).rejects.toThrow("unjournaled residual");
  expect(store.journal).toHaveLength(0);
  await commitSegmentRows(coordinator, {
    branchId: "work",
    expectedGeneration: 1,
    sourceDoc,
    rows,
  });
  expect(store.journal).toHaveLength(40);
  expect(broadcasts).toBe(1);
  expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
  await expect(
    commitSegmentRows(coordinator, {
      branchId: "work",
      expectedGeneration: 1,
      sourceDoc,
      rows: [rows[0]],
    }),
  ).rejects.toThrow("reused client");
});

const cloneOf = (doc: Y.Doc) => {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
};

describe("a save's owned session (U1)", () => {
  it("acquires nothing under the held lease and refuses a branch outside it", async () => {
    const store = new MemoryBranchStore();
    const upstream = docWithText("base");
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: upstream }));
    store.branches.set(
      "peer",
      branchSnapshot({
        branchId: "peer",
        doc: cloneOf(upstream),
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );
    store.branches.set("other", branchSnapshot({ branchId: "other", doc: docWithText("x") }));
    const mutex = new KeyedMutex();
    const run = vi.spyOn(mutex, "run");
    const sections = createBranchCriticalSections(mutex);
    const listJournalRowsForBranch = vi.fn(async () => []);
    const listConcurrentJournalRows = vi.fn(async () => []);
    const coordinator = createBranchCoordinator({
      store,
      criticalSections: sections,
      journalReads: { listJournalRowsForBranch, listConcurrentJournalRows },
    });

    await sections.withBranches(["work", "peer"], async (lease) => {
      run.mockClear();
      const session = coordinator.ownedSession(lease);
      await session.read("work", async (doc) => doc.getText("content").toString());
      await session.withTransient("peer", async () => undefined);
      await session.withStagedRows("work", async () => ({ result: 1, rows: [] }), false);
      await session.commitSegmentRows({
        branchId: "work",
        expectedGeneration: 1,
        sourceDoc: materialize(storedBranch(store, "work")),
        rows: [],
      });
      await session.checkpoint("peer");
      await session.listHelperHistory({ branchId: "work", generation: 1 });
      await session.listConcurrentRows("work", 1, { documentId: DOCUMENT_ID });
      expect(run).not.toHaveBeenCalled();
      expect(listJournalRowsForBranch).toHaveBeenCalledOnce();
      expect(listConcurrentJournalRows).toHaveBeenCalledOnce();

      for (const call of [
        () => session.read("other", async () => undefined),
        () => session.withTransient("other", async () => undefined),
        () => session.checkpoint("other"),
        () => session.listHelperHistory({ branchId: "other", generation: 1 }),
        () => session.listConcurrentRows("other", 1, { documentId: DOCUMENT_ID }),
      ])
        await expect(call()).rejects.toBeInstanceOf(BranchLeaseScopeError);
      expect(run).not.toHaveBeenCalled();
    });
  });
});

describe("containment replacement (U3)", () => {
  it("replaces a peer whose state its upstream no longer contains, and merges one that is only behind", async () => {
    const shared = docWithText("base");
    const store = new MemoryBranchStore();
    const dropped = cloneOf(shared);
    dropped.getText("content").insert(4, " discarded");
    store.branches.set(
      "peer",
      branchSnapshot({
        branchId: "peer",
        doc: dropped,
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );
    const coordinator = createBranchCoordinator({ store });

    // The upstream reforked from live, losing the peer's saved text.
    await pull(coordinator, "peer", cloneOf(shared));
    expect(storedBranch(store, "peer").generation).toBe(2);
    expect(materialize(storedBranch(store, "peer")).getText("content").toString()).toBe("base");

    const behind = cloneOf(shared);
    store.branches.set(
      "behind",
      branchSnapshot({
        branchId: "behind",
        doc: behind,
        kind: "thread_peer",
        upstreamBranchId: "work",
      }),
    );
    const ahead = cloneOf(shared);
    ahead.getText("content").insert(4, " more");
    await pull(coordinator, "behind", ahead);
    expect(storedBranch(store, "behind").generation).toBe(1);
    expect(materialize(storedBranch(store, "behind")).getText("content").toString()).toBe(
      "base more",
    );
  });
});
