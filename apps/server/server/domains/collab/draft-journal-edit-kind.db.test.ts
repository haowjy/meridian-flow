/**
 * B1 (contract §2.6 case 20): the journal read carries the inverse evidence B+ replays against.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - journal-origin edit-kind evidence for inverse replay (kb/decisions/collab/drafts/model/shared-branch-per-work.md)
 */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { documentEditParts, documentEdits, draftWriteJournal } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createDrizzleDraftReplayJournalReads } from "./adapters/drizzle-draft-journal-reads.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  THREAD_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { commitDraftEdit } from "./test-support/draft-review-requests.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it("returns editKind from the pending part's origin, independent of current text", async () => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha base.", "edit-kind");
    const f = harness.crossWorkProbeFixture();
    const documentDraft = await f.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID);
    for (const text of ["one", "two", "three"]) {
      await commitDraftEdit(f, documentDraft.draftId, { source: "agent" }, (doc) => {
        const block = f.model.getBlocks(toDocHandle(doc))[0];
        f.model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, text);
      });
    }
    const rows = await db
      .select()
      .from(draftWriteJournal)
      .where(eq(draftWriteJournal.draftId, documentDraft.draftId))
      .orderBy(draftWriteJournal.id);
    const [plain, undone, partless] = rows;
    if (!plain || !undone || !partless) throw new Error("journal rows are missing");
    // The writes above left one `write` edit part per row. Make the second an inverse edit
    // and strip the third of any part.
    const [undoPart] = await db
      .select({ id: documentEditParts.id, editId: documentEditParts.editId })
      .from(documentEditParts)
      .where(sql`${documentEditParts.origin}->>'rowId' = ${String(undone.id)}`);
    if (!undoPart) throw new Error("the second write has no edit part");
    await db
      .update(documentEdits)
      .set({ kind: "undo" })
      .where(eq(documentEdits.id, undoPart.editId));
    await db
      .delete(documentEditParts)
      .where(sql`${documentEditParts.origin}->>'rowId' = ${String(partless.id)}`);
    const read = createDrizzleDraftReplayJournalReads(db);
    const kinds = (found: Awaited<ReturnType<typeof read.listJournalRowsForDraft>>) =>
      found.map((row) => [row.id, row.editKind]);
    const input = { draftId: documentDraft.draftId };

    // Inside an open transaction, a row inserted earlier in it is read.
    await runInDrizzleTransaction(db, async () => {
      const [late] = await db
        .insert(draftWriteJournal)
        .values({ ...partless, id: undefined as never })
        .returning();
      const found = await read.listJournalRowsForDraft(input);
      expect(kinds(found)).toEqual([
        [plain.id, "write"],
        [undone.id, "undo"],
        [partless.id, undefined],
        [late?.id, undefined],
      ]);
    });
  } finally {
    await harness.cancelScheduledPulls();
  }
});
