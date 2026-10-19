/** Historical receipt evidence cannot be reconstructed from active-only policy or mutable placement. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendApplyRecord,
  applyRecordOf,
  composeGroups,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  recordRestorations,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { captureReceiptRows, recordDocumentEdit } from "./adapters/drizzle-document-edits.js";
import { createDrizzleDraftDispositionStore } from "./adapters/drizzle-draft-disposition.js";
import { createDraftDispositionReader } from "./domain/draft-disposition.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const db = createTestDatabase();
const pm = buildDocumentSchema();
const read = createDraftDispositionReader(createDrizzleDraftDispositionStore(db));
async function review(...args: Parameters<typeof read>) {
  const view = await read(...args);
  assert(view);
  return view;
}
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
const para = (text: string) => pm.nodes.paragraph.create(null, pm.text(text));

async function fixture() {
  const doc = createCollabYDoc({ gc: false });
  doc.clientID = 1;
  doc.transact(() => {
    writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), pm, [para("The old mountain waits.")]);
    writeBlocks(doc.getXmlFragment("prosemirror"), pm, [para("The old mountain waits.")]);
  });
  const [branch] = await db
    .select()
    .from(schema.branches)
    .where(eq(schema.branches.originWorkId, WORK_ID));
  const draftId = `dv-${randomUUID()}`;
  await db.insert(schema.documentDrafts).values({
    id: draftId,
    branchId: branch.id,
    documentId: ALPHA_ID,
    kind: "work_draft",
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    stateVector: Buffer.from(Y.encodeStateVector(doc)),
  });
  let revision = 0;
  async function save(status: "active" | "closed" = "active") {
    revision++;
    await db
      .update(schema.documentDrafts)
      .set({
        state: Buffer.from(Y.encodeStateAsUpdate(doc)),
        stateVector: Buffer.from(Y.encodeStateVector(doc)),
        revision,
        checkpointRevision: revision,
        status,
        closedCause: status === "closed" ? "discarded" : null,
      })
      .where(eq(schema.documentDrafts.id, draftId));
  }
  async function ai(client: number, text: string, threadId = THREAD_ID, turnId = TURN_ID) {
    const before = createCollabYDoc({ gc: false });
    Y.applyUpdate(before, Y.encodeStateAsUpdate(doc));
    doc.clientID = client;
    const updates = captureMutationUpdates(doc, () =>
      doc.transact(() => writeBlocks(doc.getXmlFragment("prosemirror"), pm, [para(text)])),
    );
    const [row] = await db
      .insert(schema.draftWriteJournal)
      .values({
        draftId,
        generation: 1,
        draftBaseUpdateSeq: 0,
        updateData: Buffer.from(Y.mergeUpdates(updates)),
        source: "agent",
        threadId,
        turnId,
        toolCallId: `write-${client}`,
        wId: client,
      })
      .returning();
    const origin = { kind: "pending" as const, draftId, generation: 1, rowId: row.id };
    const receipts = captureReceiptRows(before, [{ update: Y.mergeUpdates(updates), origin }]);
    before.destroy();
    const editId = await recordDocumentEdit(db, {
      documentId: ALPHA_ID,
      threadId,
      turnId,
      actor: "agent",
      wId: client,
      receipts,
    });
    revision++;
    await db
      .update(schema.documentDrafts)
      .set({ revision })
      .where(eq(schema.documentDrafts.id, draftId));
    return editId;
  }
  async function apply() {
    const view = await review(draftId);
    const entry = applyRecordOf(view.classifications, view.classifications.keys());
    doc.clientID = 1;
    doc.transact(() => {
      appendApplyRecord(doc, entry);
      writeBlocks(
        doc.getXmlFragment(REVIEW_BASE_FRAGMENT),
        pm,
        readBlocks(doc.getXmlFragment("prosemirror"), pm),
      );
    });
    await save();
  }
  return { doc, draftId, ai, save, apply };
}

it("reads applied and discarded historical parts after close, independent of placement and generation", async () => {
  const f = await fixture();
  try {
    const applied = await f.ai(21, "The bright mountain waits.");
    expect((await review(f.draftId)).parts.find((p) => p.editId === applied)?.disposition).toBe(
      "pending",
    );
    await f.apply();
    expect((await review(f.draftId)).parts.find((p) => p.editId === applied)?.disposition).toBe(
      "applied",
    );
    const discarded = await f.ai(22, "The bright mountain sings.");
    f.doc.clientID = 99;
    f.doc.transact(() =>
      writeBlocks(f.doc.getXmlFragment("prosemirror"), pm, [para("The bright mountain waits.")]),
    );
    await f.save();
    expect((await review(f.draftId)).parts.find((p) => p.editId === discarded)?.disposition).toBe(
      "discarded",
    );
    const visibleClosed = await f.ai(23, "The bright mountain glows.");
    await f.save("closed");
    await db
      .update(schema.documentDrafts)
      .set({ generation: 2 })
      .where(eq(schema.documentDrafts.id, f.draftId));
    await db.update(schema.documentEditParts).set({ placement: { kind: "retired" } });
    const historical = await review(f.draftId, { writerRanges: [[99, 0, 100]] });
    expect(historical.draft.status).toBe("closed");
    expect(historical.parts.map((p) => [p.editId, p.disposition])).toEqual([
      [visibleClosed, "discarded"],
      [discarded, "discarded"],
      [applied, "applied"],
    ]);
    expect(historical.provenance?.writers).toBeUndefined();
    expect(historical.projection?.hasChanges).toBe(true);
    await db.delete(schema.turns).where(eq(schema.turns.id, TURN_ID));
    const orphaned = await review(f.draftId);
    expect(orphaned.parts.map((part) => [part.editId, part.disposition])).toEqual(
      historical.parts.map((part) => [part.editId, part.disposition]),
    );
    expect(orphaned.parts.every((part) => part.owner === null)).toBe(true);
    expect([...orphaned.classifications.values()].flatMap((change) => change.byline)).toEqual([]);
    expect(await read("missing-draft")).toBeNull();
    await db
      .update(schema.documentDrafts)
      .set({ state: Buffer.alloc(0), stateVector: Buffer.alloc(0) })
      .where(eq(schema.documentDrafts.id, f.draftId));
    await db
      .delete(schema.draftWriteJournal)
      .where(eq(schema.draftWriteJournal.draftId, f.draftId));
    await db
      .update(schema.documentDrafts)
      .set({ status: "active", closedCause: null })
      .where(eq(schema.documentDrafts.id, f.draftId));
    await expect(read(f.draftId)).rejects.toThrow("Missing draft checkpoint");
    await db
      .update(schema.documentDrafts)
      .set({ status: "closed", closedCause: "discarded" })
      .where(eq(schema.documentDrafts.id, f.draftId));
    const released = await review(f.draftId);
    expect(released.projection).toBeNull();
    expect(released.provenance).toBeNull();
    expect(released.parts.every((p) => p.disposition === "discarded")).toBe(true);
  } finally {
    f.doc.destroy();
  }
});

it("rolls a subagent receipt and its byline up to the owning conversation's spawn", async () => {
  const f = await fixture();
  try {
    const child = randomUUID() as typeof THREAD_ID,
      childTurn = randomUUID() as typeof TURN_ID;
    await db.insert(schema.threads).values({
      id: child,
      rootThreadId: THREAD_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      kind: "subagent",
      parentThreadId: THREAD_ID,
      originTurnId: TURN_ID,
      originType: "spawn",
      spawnStatus: "running",
      spawnDepth: 1,
    });
    await db.insert(schema.turns).values({
      id: childTurn,
      threadId: child,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const editId = await f.ai(31, "The silver mountain waits.", child, childTurn);
    const view = await review(f.draftId);
    expect(view.parts[0]).toMatchObject({
      editId,
      disposition: "pending",
      owner: {
        threadId: THREAD_ID,
        reveal: { threadId: THREAD_ID, turnId: TURN_ID, subagentThreadId: child },
      },
    });
    expect([...view.classifications.values()][0].byline).toEqual([
      { kind: "thread", threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect([...view.classifications.values()][0].members).toEqual([0]);
    expect(view.provenance?.snapshot.sv.get(31)).toBeGreaterThan(0);
  } finally {
    f.doc.destroy();
  }
});

it("retains Apply evidence when Undo restored AI items before they were applied", async () => {
  const f = await fixture();
  try {
    await f.ai(41, "The golden mountain waits.");
    f.doc.clientID = 98;
    const origin = Symbol("discard");
    const history = new Y.UndoManager(f.doc.getXmlFragment("prosemirror"), {
      trackedOrigins: new Set([origin]),
    });
    recordRestorations(history);
    const view = await review(f.draftId);
    assert(view.projection);
    const patches = composeGroups(
      pm,
      view.projection,
      view.projection.groups.map((g) => g.id),
      "discard",
    );
    // A whole-document fixture has one block patch. The browser writes the same composed blocks.
    f.doc.transact(
      () => writeBlocks(f.doc.getXmlFragment("prosemirror"), pm, patches[0].blocks),
      origin,
    );
    history.undo();
    history.destroy();
    await f.save();
    expect((await review(f.draftId)).parts[0].disposition).toBe("pending");
    await f.apply();
    await f.save("closed");
    expect((await review(f.draftId)).parts[0].disposition).toBe("applied");
  } finally {
    f.doc.destroy();
  }
});
