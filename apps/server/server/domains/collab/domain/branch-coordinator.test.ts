/** Shadow branch coordinator conformance for peer pulls and CAS persistence. */

import { captureRebaseCut, readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  allocateDocumentClient,
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
} from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { commitJournaledUpdate, commitSegmentRows } from "../test-support/branch-update-writes.js";
import { captureHistoricalBranchRow } from "../test-support/historical-branch-row.js";
import {
  type BranchSnapshot,
  type BranchStore,
  createBranchCoordinator,
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
    draftId: "draft-1",
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

  readonly cuts: Uint8Array[] = [];

  async readRebaseCuts(): Promise<Uint8Array[]> {
    return this.cuts;
  }

  async updateBranchSnapshot(input: {
    branchId: string;
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

  private persist(
    input: {
      branchId: string;
      expectedGeneration?: number;
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
    if (!current) return false;
    if (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration)
      return false;
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
    expectedState?: Uint8Array;
    state: Uint8Array;
    stateVector: Uint8Array;
    journals?: readonly { updateData: Uint8Array }[];
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
    for (const row of input.journals ?? []) this.journal.push(row.updateData);
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
        updateData: Y.encodeStateAsUpdate(branchDoc),
        actorUserId: "user-1",
        roomDocument: materialize(storedBranch(store, "work")),
      }),
    ).resolves.toEqual({ admitted: false });

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedBranch(store, "work")).getText("content").toString()).toBe("seed");
  });

  // Risk: a reconnect's cumulative sync.step2 repeats the admitted writer struct and the server's own
  // tombstones; it was judged as fresh authorship (refused, 4410) or reported as a lost late-peer edit.
  it("admits a cumulative reconnect frame with repeated server tombstones as a no-op, reporting nothing", async () => {
    const server = documentWithReservedFacts();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("hello")]);
    server.getXmlFragment("prosemirror").insert(0, [paragraph]);
    const dropped = new Y.XmlElement("paragraph");
    dropped.insert(0, [new Y.XmlText("gone")]);
    server.getXmlFragment("prosemirror").insert(1, [dropped]);
    server.getXmlFragment("prosemirror").delete(1, 1);
    const store = new MemoryBranchStore();
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: server }));
    const serverVector = Y.encodeStateVector(server);
    const writer = materialize(storedBranch(store, "work"));
    writer.clientID = allocateDocumentClient(writer);
    let typing: Uint8Array = new Uint8Array();
    writer.once("update", (update: Uint8Array) => {
      typing = update;
    });
    const text = (writer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(5, " world");
    const reports: unknown[] = [];
    const coordinator = createBranchCoordinator({
      store,
      onLateWriterEdits: (report) => reports.push(report),
    });
    const room = materialize(storedBranch(store, "work"));
    Y.applyUpdate(room, typing);
    await expect(
      coordinator.commitWriterUpdate({ branchId: "work", updateData: typing, roomDocument: room }),
    ).resolves.toEqual({ admitted: true });

    await expect(
      coordinator.commitWriterUpdate({
        branchId: "work",
        updateData: Y.encodeStateAsUpdate(writer, serverVector),
        roomDocument: room,
      }),
    ).resolves.toEqual({ admitted: false });
    expect(store.journal).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  // Risk (D32): a reconnect repeats the client's whole delete set; recovering a late deletion erased words
  // the writer wrote back since (K1-1). Late deletions of rebased text are log-only, so replay is inert.
  it("never lets a replayed late deletion erase words written since", async () => {
    const schema = buildDocumentSchema();
    const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const fragmentTexts = (doc: Y.Doc) =>
      readBlocks(doc.getXmlFragment("prosemirror"), schema).map((block) => block.textContent);
    const server = new Y.Doc({ gc: false });
    server.clientID = 1;
    server.transact(() =>
      writeBlocks(server.getXmlFragment("prosemirror"), schema, [
        para("alpha beta gamma"),
        para("tail"),
      ]),
    );
    const peer = materialize(branchSnapshot({ branchId: "seed", doc: server }));
    peer.clientID = 1000;
    let deletion: Uint8Array = new Uint8Array();
    peer.once("update", (update: Uint8Array) => {
      deletion = update;
    });
    ((peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(6, 5);
    const store = new MemoryBranchStore();
    store.cuts.push(captureRebaseCut(server));
    server.transact(
      () =>
        writeBlocks(server.getXmlFragment("prosemirror"), schema, [
          para("tail"),
          para("ALPHA beta gamma"),
        ]),
      "rebase",
    );
    store.branches.set("work", branchSnapshot({ branchId: "work", doc: server }));
    const coordinator = createBranchCoordinator({ store });
    const room = materialize(storedBranch(store, "work"));
    const commit = (updateData: Uint8Array) =>
      coordinator.commitWriterUpdate({ branchId: "work", updateData, roomDocument: room });
    const current = () => fragmentTexts(materialize(storedBranch(store, "work")));

    await commit(deletion);
    expect(current()).toEqual(["tail", "ALPHA beta gamma"]);
    const writer = materialize(storedBranch(store, "work"));
    writer.clientID = allocateDocumentClient(writer);
    let retype: Uint8Array = new Uint8Array();
    writer.once("update", (update: Uint8Array) => {
      retype = update;
    });
    ((writer.getXmlFragment("prosemirror").get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(
      16,
      "!",
    );
    await commit(retype);
    expect(current()).toEqual(["tail", "ALPHA beta gamma!"]);

    await commit(deletion);
    expect(current()).toEqual(["tail", "ALPHA beta gamma!"]);
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
        updateData,
        actorUserId: "user-1",
        roomDocument,
      }),
    ).rejects.toThrow("server-owned state");

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
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

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
      sourceDoc,
      rows: rows.slice(0, -1),
    }),
  ).rejects.toThrow("unjournaled residual");
  expect(store.journal).toHaveLength(0);
  await commitSegmentRows(coordinator, {
    branchId: "work",
    sourceDoc,
    rows,
  });
  expect(store.journal).toHaveLength(40);
  expect(broadcasts).toBe(1);
  expect(storedBranch(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
  await expect(
    commitSegmentRows(coordinator, {
      branchId: "work",
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

describe("peer containment", () => {
  it("never replaces a peer its upstream lacks: it reports, and still merges one that is only behind", async () => {
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
    const notContained = vi.fn();
    const coordinator = createBranchCoordinator({ store, onPeerNotContained: notContained });

    // With no reset or refork an upstream only grows: a peer that is ahead of it is a bug to report,
    // not a state to repair by resetting the peer.
    await pull(coordinator, "peer", cloneOf(shared));
    expect(notContained).toHaveBeenCalledWith({ branchId: "peer", upstreamBranchId: "work" });
    expect(storedBranch(store, "peer").generation).toBe(1);
    expect(materialize(storedBranch(store, "peer")).getText("content").toString()).toBe(
      "base discarded",
    );

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
    notContained.mockClear();
    await pull(coordinator, "behind", ahead);
    expect(notContained).not.toHaveBeenCalled();
    expect(materialize(storedBranch(store, "behind")).getText("content").toString()).toBe(
      "base more",
    );
  });
});
