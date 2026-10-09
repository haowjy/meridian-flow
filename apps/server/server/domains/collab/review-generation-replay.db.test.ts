/** Successor-generation admission preserves surviving writer edits and certifies Undo aliases. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import {
  captureUndoRestorationClaims,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it.each([
  { command: "apply", restoration: false },
  { command: "discard-change", restoration: false },
  { command: "discard-draft", restoration: false },
  { command: "apply", restoration: true },
] as const)("admits surviving typing after $command (Undo: $restoration)", async ({
  command,
  restoration,
}) => {
  const harness = createHarness(db);
  const docs: Y.Doc[] = [];
  const clone = (doc: Y.Doc) => {
    const copy = createCollabYDoc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    docs.push(copy);
    return copy;
  };
  try {
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "generation-replay");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    docs.push(branch.doc);
    const ai = clone(branch.doc);
    const edit = (doc: Y.Doc, blockIndex: number, from: number, to: number, text: string) => {
      const block = f.model.getBlocks(toDocHandle(doc))[blockIndex];
      f.model.applyTextEdit(toDocHandle(doc), block, { from, to }, text);
    };
    ai.clientID = 731000;
    edit(ai, 0, 11, 11, " Proposed");
    await f.branchCoordinator.commitSyncFromDoc({
      branchId: branch.branchId,
      sourceDoc: ai,
      expectedGeneration: branch.generation,
      source: "agent",
      actorUserId: null,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      wId: null,
      updateMeta: null,
    });
    const writer = await f.branchCoordinator.readBranch(branch.branchId, async (doc) => clone(doc));
    writer.clientID = 731001;
    const updates: Uint8Array[] = [];
    writer.on("update", (update) => updates.push(update));
    if (restoration) {
      captureUndoRestorationClaims(writer);
      const undo = new Y.UndoManager(writer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), {
        trackedOrigins: new Set(["writer"]),
      });
      writer.transact(() => edit(writer, 0, 12, 16, ""), "writer");
      undo.undo();
      undo.destroy();
    } else if (command === "apply") {
      edit(writer, 0, 20, 20, " MINE");
    } else {
      edit(writer, 1, 10, 10, " MINE");
    }
    const request = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await f.collab.draftReview.preview(request);
    if (preview.status !== "active") throw new Error("missing review");
    const selection = {
      ...request,
      operationIds: preview.operations.map((operation) => operation.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    };
    await (command === "apply"
      ? f.collab.draftReview.applyWorkDraftChanges(selection)
      : f.collab.draftReview.discardWorkDraft(command === "discard-change" ? selection : request));
    expect(await f.collab.draftReview.list({ workId: WORK_ID })).toHaveLength(0);
    const liveBeforeReplay = await harness.liveMarkdown(ALPHA_ID);
    const next = await f.branchCoordinator.readBranch(branch.branchId, async (doc, state) => ({
      doc: clone(doc),
      generation: state.generation,
    }));
    expect(next.generation).toBe(branch.generation + 1);
    // Public update events include integrated structs and only the carry's own deletions.
    const scratch = clone(next.doc);
    const integrated: Uint8Array[] = [];
    scratch.on("update", (update) => integrated.push(update));
    Y.applyUpdate(scratch, Y.mergeUpdates(updates));
    expect(integrated.length).toBeGreaterThan(0);
    const deliverable = Y.mergeUpdates(integrated);
    expect(
      await f.branchCoordinator.commitWriterUpdate({
        branchId: branch.branchId,
        updateData: deliverable,
        expectedGeneration: next.generation,
        roomDocument: next.doc,
        actorUserId: USER_ID,
      }),
    ).toMatchObject({ admitted: true });
    expect(await f.collab.draftReview.list({ workId: WORK_ID })).toHaveLength(1);
    const reopened = await f.collab.draftReview.preview(request);
    if (reopened.status !== "active") throw new Error("missing reopened review");
    // Undo restores already-applied AI text: its certified alias creates no visible diff.
    expect(reopened.operations).toHaveLength(restoration ? 0 : 1);
    if (!restoration) expect(reopened.operations[0]).toMatchObject({ kind: "writer" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(liveBeforeReplay);
    expect(await f.draftMarkdown(branch.branchId)).toContain(restoration ? "Proposed" : "MINE");
    const rows = await db
      .select()
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.branchId, branch.branchId));
    const replay = rows.find(
      (row) => row.generation === next.generation && row.source === "writer",
    );
    expect(replay).toMatchObject({ actorUserId: USER_ID, status: "active" });
    if (restoration)
      expect(replay?.updateMeta).toMatchObject({
        restorationAliases: [
          { source: { client: 731000, length: 4 }, target: { client: 731001, length: 4 } },
        ],
      });
    await f.branchCoordinator.readBranch(branch.branchId, async (doc) => {
      expect(doc.store.pendingStructs).toBeNull();
      expect(doc.store.pendingDs).toBeNull();
    });
  } finally {
    for (const doc of docs) doc.destroy();
    harness.destroyWarmState();
  }
});
