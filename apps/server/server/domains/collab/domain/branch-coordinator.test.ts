/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBranchRows } from "../test-support/branch-store-seam.js";
import { commitJournaledUpdate, resetBranchFromDoc } from "../test-support/branch-update-writes.js";
import { captureHistoricalBranchRow } from "../test-support/historical-branch-row.js";
import {
  type MemoryBranch,
  MemoryBranchStore,
  memoryBranch,
  testBranchRow,
} from "../test-support/memory-branch-store.js";
import { createBranchCoordinator } from "./branch-coordinator.js";
import { PROVENANCE_TARGETS_TYPE } from "./provenance.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000501" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000502" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000503" as ThreadId;

function pull(
  coordinator: ReturnType<typeof createBranchCoordinator>,
  branchId: string,
  upstream: Y.Doc,
) {
  return coordinator.pullFromDoc({ branchId, upstream });
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

/** A branch's materialized content (checkpoint ⊕ tail), for assertions. */
type StoredBranch = MemoryBranch & { state: Uint8Array; stateVector: Uint8Array };

function branchSnapshot(input: {
  branchId: string;
  doc: Y.Doc;
  kind?: "work_draft" | "thread_peer";
  upstreamBranchId?: string | null;
}): MemoryBranch {
  return memoryBranch(
    testBranchRow({
      branchId: input.branchId,
      documentId: DOCUMENT_ID,
      kind: input.kind ?? "work_draft",
      upstreamBranchId: input.upstreamBranchId ?? null,
      workId: WORK_ID,
      threadId: input.kind === "thread_peer" ? THREAD_ID : null,
    }),
    input.doc,
  );
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
    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });

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

    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });
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

    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });
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

    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });
    await expect(
      coordinator.commitSegmentRows({
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
      appendBranchRows(store, "work", [
        { updateData: Y.encodeStateAsUpdate(deleteOnlyDoc, before), source: "writer" },
      ]),
    ).resolves.toHaveLength(1);

    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });
    await expect(
      coordinator.resetFromDoc({
        branchId: "work",
        upstream: docWithText("fresh live"),
        policy: "exact",
        expectedGeneration: original.generation,
        expectedRevision: original.revision,
        schemaVersion: original.schemaVersion,
      }),
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
    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });
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
    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });

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

it("installs ordered segment rows once and rejects reused clients and unjournaled residuals", async () => {
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
  const coordinator = createBranchCoordinator({
    onAppendCommitted: () => {},
    store,
    onBranchUpdate: () => broadcasts++,
  });
  await expect(
    coordinator.commitSegmentRows({
      branchId: "work",
      expectedGeneration: 1,
      sourceDoc,
      rows: rows.slice(0, -1),
    }),
  ).rejects.toThrow("unjournaled residual");
  expect(store.journal).toHaveLength(0);
  await coordinator.commitSegmentRows({
    branchId: "work",
    expectedGeneration: 1,
    sourceDoc,
    rows,
  });
  expect(store.journal).toHaveLength(40);
  expect(broadcasts).toBe(1);
  expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
  await expect(
    coordinator.commitSegmentRows({
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
    const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store });

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
