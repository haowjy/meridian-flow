/** Draft writer admission and response journal persistence.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Ordered draft segments install atomically
 */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { commitDraftRows, commitJournaledUpdate } from "../test-support/draft-update-writes.js";
import { captureHistoricalDraftRow } from "../test-support/historical-draft-row.js";
import {
  type MemoryDraft,
  MemoryDraftStore,
  memoryDraft,
  testDraftRow,
} from "../test-support/memory-draft-store.js";
import { createDraftCoordinator } from "./draft-coordinator.js";
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
  doc.getMap(PROVENANCE_TARGETS_TYPE).set("nested", nested);
  nested.push(["authority fact"]);
  return doc;
}

/** A draft's materialized content (checkpoint ⊕ tail), for assertions. */
type StoredDraft = MemoryDraft & { state: Uint8Array; stateVector: Uint8Array };

function draftSnapshot(input: {
  draftId: string;
  doc: Y.Doc;
  kind?: "work_draft" | "thread_peer";
  upstreamDraftId?: string | null;
}): MemoryDraft {
  return memoryDraft(
    testDraftRow({
      draftId: input.draftId,
      documentId: DOCUMENT_ID,
      kind: input.kind ?? "work_draft",
      upstreamDraftId: input.upstreamDraftId ?? null,
      workId: WORK_ID,
      threadId: input.kind === "thread_peer" ? THREAD_ID : null,
    }),
    input.doc,
  );
}

function storedDraft(store: MemoryDraftStore, draftId: string): StoredDraft {
  const documentDraft = store.drafts.get(draftId);
  if (!documentDraft) throw new Error(`Missing draft ${draftId}`);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, documentDraft.checkpoint.state);
  for (const row of documentDraft.rows)
    if (row.id > documentDraft.checkpointSeq) Y.applyUpdate(doc, row.update);
  return {
    ...documentDraft,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
  };
}

function materialize(snapshot: { state: Uint8Array } | MemoryDraft): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, "state" in snapshot ? snapshot.state : snapshot.checkpoint.state);
  return doc;
}

describe("DraftCoordinator", () => {
  it("acknowledges already-contained draft writer updates without another journal row", async () => {
    const store = new MemoryDraftStore();
    const draftDoc = docWithText("seed");
    store.drafts.set("work", draftSnapshot({ draftId: "work", doc: draftDoc }));
    const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });

    await expect(
      coordinator.commitWriterUpdate({
        draftId: "work",
        updateData: Y.encodeStateAsUpdate(draftDoc),
        actorUserId: "user-1",
        roomDocument: materialize(storedDraft(store, "work")),
      }),
    ).resolves.toEqual({ admitted: false });

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedDraft(store, "work")).getText("content").toString()).toBe("seed");
  });

  it("rejects reserved namespace deletion against the snapshot it would commit", async () => {
    const store = new MemoryDraftStore();
    const draftDoc = documentWithReservedFacts();
    store.drafts.set("work", draftSnapshot({ draftId: "work", doc: draftDoc }));
    const roomDocument = materialize(storedDraft(store, "work"));
    const hostileClient = materialize(storedDraft(store, "work"));
    const before = Y.encodeStateVector(hostileClient);
    hostileClient.getMap(PROVENANCE_TARGETS_TYPE).delete("nested");
    const updateData = Y.encodeStateAsUpdate(hostileClient, before);

    const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });
    await expect(
      coordinator.commitWriterUpdate({
        draftId: "work",
        updateData,
        actorUserId: "user-1",
        roomDocument,
      }),
    ).rejects.toThrow("reserved provenance");

    expect(store.journal).toHaveLength(0);
    expect(materialize(storedDraft(store, "work")).getMap(PROVENANCE_TARGETS_TYPE).size).toBe(1);
  });

  it("journals only new multi-range deletions so replay reaches byte-identical state", async () => {
    const store = new MemoryDraftStore();
    const base = docWithText("abcdef");
    const workDoc = materialize(draftSnapshot({ draftId: "base", doc: base }));
    workDoc.getText("content").delete(2, 1);
    store.drafts.set("work", draftSnapshot({ draftId: "work", doc: workDoc }));
    const beforeWork = storedDraft(store, "work");

    const sourceDoc = materialize(beforeWork);
    sourceDoc.getText("content").delete(1, 1);
    sourceDoc.getText("content").delete(2, 1);

    const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });
    await expect(
      commitDraftRows(coordinator, {
        draftId: "work",
        sourceDoc: sourceDoc,
        rows: [
          {
            draftId: "work",
            updateData: await captureHistoricalDraftRow(coordinator, "work", sourceDoc),
            source: "agent",
            threadId: THREAD_ID,
          },
        ],
      }),
    ).resolves.toBe(true);

    expect(store.journal).toHaveLength(1);
    const replayed = materialize(beforeWork);
    Y.applyUpdate(replayed, store.journal[0]);

    expect(replayed.getText("content").toString()).toBe("adf");
    expect(Y.encodeStateAsUpdate(replayed)).toEqual(Y.encodeStateAsUpdate(sourceDoc));
    expect(storedDraft(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
  });

  it("does not mutate the cached draft doc when journal append fails", async () => {
    const store = new MemoryDraftStore();
    store.drafts.set("work", draftSnapshot({ draftId: "work", doc: new Y.Doc({ gc: false }) }));
    const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });
    const update = Y.encodeStateAsUpdate(docWithText("failed write"));
    store.failNextJournal = true;

    await expect(
      commitJournaledUpdate(coordinator, {
        draftId: "work",
        updateData: update,
        source: "agent",
        threadId: THREAD_ID,
      }),
    ).rejects.toThrow(/injected journal failure/);

    await coordinator.deliverCommitted("work");
    expect(store.journal).toHaveLength(0);
    expect(materialize(storedDraft(store, "work")).getText("content").toString()).toBe("");
  });
});

it("installs ordered segment rows once and rejects reused clients and unjournaled residuals", async () => {
  const store = new MemoryDraftStore();
  const base = docWithText("start");
  store.drafts.set("work", draftSnapshot({ draftId: "work", doc: base }));
  const sourceDoc = materialize(storedDraft(store, "work"));
  const rows = [];
  for (let i = 0; i < 40; i++) {
    sourceDoc.clientID = allocateDocumentClient(sourceDoc);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    sourceDoc.on("update", collect);
    sourceDoc.getText("content").insert(sourceDoc.getText("content").length, ` ${i}`);
    sourceDoc.off("update", collect);
    rows.push({
      draftId: "work",
      source: "agent" as const,
      updateData: Y.mergeUpdates(updates),
      toolCallId: i < 20 ? "first" : "second",
      wId: i < 20 ? 1 : 2,
    });
  }
  let broadcasts = 0;
  const coordinator = createDraftCoordinator({
    onAppendCommitted: () => {},
    store,
    onDraftUpdate: () => broadcasts++,
  });
  await expect(
    commitDraftRows(coordinator, {
      draftId: "work",
      sourceDoc,
      rows: rows.slice(0, -1),
    }),
  ).rejects.toThrow("unjournaled residual");
  expect(store.journal).toHaveLength(0);
  await commitDraftRows(coordinator, {
    draftId: "work",
    sourceDoc,
    rows,
  });
  expect(store.journal).toHaveLength(40);
  expect(broadcasts).toBe(1);
  expect(storedDraft(store, "work").state).toEqual(Y.encodeStateAsUpdate(sourceDoc));
  await expect(
    commitDraftRows(coordinator, {
      draftId: "work",
      sourceDoc,
      rows: [rows[0]],
    }),
  ).rejects.toThrow("reused client");
});
