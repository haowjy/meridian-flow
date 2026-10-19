/** Successor-generation admission preserves surviving writer edits. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
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
} from "./test-support/change-trail-postgres-harness.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";
import { readResolvedDraft } from "./test-support/draft-store-seam.js";
import { captureHistoricalDraftRow } from "./test-support/historical-draft-row.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it.each([
  "apply",
  "discard-change",
  "discard-draft",
] as const)("admits surviving typing after %s", async (command) => {
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
    const documentDraft = await readResolvedDraft(
      f.draftStore,
      await f.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID),
    );
    docs.push(documentDraft.doc);
    const ai = clone(documentDraft.doc);
    const edit = (doc: Y.Doc, blockIndex: number, from: number, to: number, text: string) => {
      const block = f.model.getBlocks(toDocHandle(doc))[blockIndex];
      f.model.applyTextEdit(toDocHandle(doc), block, { from, to }, text);
    };
    ai.clientID = 731000;
    edit(ai, 0, 11, 11, " Proposed");
    await f.draftCoordinator.commitSegmentRows({
      draftId: documentDraft.draftId,
      sourceDoc: ai,
      expectedGeneration: documentDraft.generation,
      rows: [
        {
          draftId: documentDraft.draftId,
          updateData: await captureHistoricalDraftRow(
            f.draftCoordinator,
            documentDraft.draftId,
            ai,
          ),
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        },
      ],
    });
    const writer = await f.draftCoordinator.readDraft(documentDraft.draftId, async (doc) =>
      clone(doc),
    );
    writer.clientID = 731001;
    const updates: Uint8Array[] = [];
    writer.on("update", (update) => updates.push(update));
    if (command === "apply") {
      edit(writer, 0, 20, 20, " MINE");
    } else {
      edit(writer, 1, 10, 10, " MINE");
    }
    const review = reviewDriver(f.collab.draftReview);
    const preview = await review.activePreview(ALPHA_ID);
    const disposition = await (command === "apply"
      ? review.applyChanges(ALPHA_ID, preview)
      : command === "discard-change"
        ? review.discardChanges(ALPHA_ID, preview)
        : review.discardItem(ALPHA_ID));
    expect(disposition).toMatchObject({ status: command === "apply" ? "applied" : "discarded" });
    expect(await review.list()).toHaveLength(0);
    const liveBeforeReplay = await harness.liveMarkdown(ALPHA_ID);
    const next = await f.draftCoordinator.readDraft(documentDraft.draftId, async (doc, state) => ({
      doc: clone(doc),
      generation: state.generation,
    }));
    expect(next.generation).toBe(documentDraft.generation + 1);
    // Public update events include integrated structs and only the carry's own deletions.
    const scratch = clone(next.doc);
    const integrated: Uint8Array[] = [];
    scratch.on("update", (update) => integrated.push(update));
    Y.applyUpdate(scratch, Y.mergeUpdates(updates));
    expect(integrated.length).toBeGreaterThan(0);
    const deliverable = Y.mergeUpdates(integrated);
    expect(
      await f.draftCoordinator.commitWriterUpdate({
        draftId: documentDraft.draftId,
        updateData: deliverable,
        expectedGeneration: next.generation,
        roomDocument: next.doc,
        actorUserId: USER_ID,
      }),
    ).toMatchObject({ admitted: true });
    expect(await review.list()).toHaveLength(1);
    const reopened = await review.activePreview(ALPHA_ID);
    expect(reopened.operations).toHaveLength(1);
    expect(reopened.operations[0]).toMatchObject({ kind: "writer" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(liveBeforeReplay);
    expect(await f.draftMarkdown(documentDraft.draftId)).toContain("MINE");
    const rows = await db
      .select()
      .from(schema.draftWriteJournal)
      .where(eq(schema.draftWriteJournal.draftId, documentDraft.draftId));
    const replay = rows.find(
      (row) => row.generation === next.generation && row.source === "writer",
    );
    expect(replay).toMatchObject({ actorUserId: USER_ID, status: "active" });
    await f.draftCoordinator.readDraft(documentDraft.draftId, async (doc) => {
      expect(doc.store.pendingStructs).toBeNull();
      expect(doc.store.pendingDs).toBeNull();
    });
  } finally {
    for (const doc of docs) doc.destroy();
    harness.destroyWarmState();
  }
});
