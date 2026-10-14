/** B1 (contract §2.6 case 20): the journal read carries the inverse evidence B+ replays against. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { branchWriteJournal, documentEditParts, documentEdits } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createDrizzleBranchJournalReadStore } from "./adapters/drizzle-branch-push.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetSettlementFixture,
} from "./test-support/branch-push-settlement-fixture.js";
import { THREAD_ID } from "./test-support/change-trail-postgres-harness.js";
import { commitBranchEdit } from "./test-support/draft-review-requests.js";

const db = createTestDatabase();
beforeEach(() => resetSettlementFixture(db));
afterAll(() => closeDatabase(db));

it("returns editKind from the pending part's origin, whatever its placement or text became", async () => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha base.", "edit-kind");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    for (const text of ["one", "two", "three"]) {
      await commitBranchEdit(f, branch.branchId, { source: "agent" }, (doc) => {
        const block = f.model.getBlocks(toDocHandle(doc))[0];
        f.model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, text);
      });
    }
    const rows = await db
      .select()
      .from(branchWriteJournal)
      .where(eq(branchWriteJournal.branchId, branch.branchId))
      .orderBy(branchWriteJournal.id);
    const [plain, undone, partless] = rows;
    if (!plain || !undone || !partless) throw new Error("journal rows are missing");
    // The writes above left one `write` edit part per row. Make the second an inverse edit
    // whose part was moved off its branch, and strip the third of any part.
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
      .update(documentEditParts)
      .set({ placement: { kind: "retired" } as never })
      .where(eq(documentEditParts.id, undoPart.id));
    await db
      .delete(documentEditParts)
      .where(sql`${documentEditParts.origin}->>'rowId' = ${String(partless.id)}`);
    const read = createDrizzleBranchJournalReadStore(db);
    const kinds = (found: Awaited<ReturnType<typeof read.listJournalRowsForBranch>>) =>
      found.map((row) => [row.id, row.editKind]);
    const input = { branchId: branch.branchId };

    // Inside an open transaction, a row inserted earlier in it is read.
    await runInDrizzleTransaction(db, async () => {
      const [late] = await db
        .insert(branchWriteJournal)
        .values({ ...partless, id: undefined as never })
        .returning();
      const found = await read.listJournalRowsForBranch(input);
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
