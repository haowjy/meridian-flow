import type { Database } from "@meridian/database";
import {
  documentDrafts,
  documentEditParts,
  documentEdits,
  draftWriteJournal,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "../domain/draft-journal.js";

const journalColumns = {
  id: draftWriteJournal.id,
  draftId: draftWriteJournal.draftId,
  wId: draftWriteJournal.wId,
  toolCallId: draftWriteJournal.toolCallId,
  source: draftWriteJournal.source,
  threadId: draftWriteJournal.threadId,
  turnId: draftWriteJournal.turnId,
  actorUserId: draftWriteJournal.actorUserId,
  updateData: draftWriteJournal.updateData,
  draftBaseUpdateSeq: draftWriteJournal.draftBaseUpdateSeq,
  status: draftWriteJournal.status,
  updateMeta: draftWriteJournal.updateMeta,
};
type JournalRecord = Pick<typeof draftWriteJournal.$inferSelect, keyof typeof journalColumns>;

export function createDrizzleDraftReplayJournalReads(db: Database): DraftReplayJournalReads {
  return {
    async listJournalRowsForDraft(input) {
      const conditions = [eq(draftWriteJournal.draftId, input.draftId)];
      if (input.throughJournalId !== undefined) {
        conditions.push(sql`${draftWriteJournal.id} <= ${input.throughJournalId}`);
      }
      const rows = await currentDrizzleDb(db)
        .select({
          row: journalColumns,
          editKind: documentEdits.kind,
        })
        .from(draftWriteJournal)
        .leftJoin(
          documentEditParts,
          sql`
          ${documentEditParts.origin}->>'kind' = 'pending'
          and ${documentEditParts.origin}->>'draftId' = ${draftWriteJournal.draftId}::text
          and ${documentEditParts.origin}->>'rowId' = ${draftWriteJournal.id}::text
        `,
        )
        .leftJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
        .where(and(...conditions))
        .orderBy(draftWriteJournal.id);
      // A row can carry several parts of one edit: one entry per row, in journal order.
      const byRow = new Map<number, ReturnType<typeof mapJournalRow>>();
      for (const { row, editKind } of rows) {
        const seen = byRow.get(row.id);
        if (!seen || (!seen.editKind && editKind)) {
          byRow.set(row.id, { ...mapJournalRow(row), ...(editKind ? { editKind } : {}) });
        }
      }
      return [...byRow.values()];
    },

    async listConcurrentJournalRows(draftId, options) {
      const floor = options.afterJournalId ?? 0;
      // A save's attribution reads inside its own transaction: the root pool handle would
      // wait on another connection and miss that transaction's uncommitted rows.
      const rows = await currentDrizzleDb(db)
        .select({ row: journalColumns })
        .from(draftWriteJournal)
        .innerJoin(documentDrafts, eq(draftWriteJournal.draftId, documentDrafts.id))
        .where(
          and(
            eq(documentDrafts.documentId, options.documentId),
            sql`${draftWriteJournal.id} > ${floor}`,
            // Same-draft active rows and cross-draft pushed rows are both needed for
            // attribution. Cold-start scans are deliberately unbounded until we add a
            // push-ordered floor; max(journal.id) is unsound because journal ids can include
            // unpushed sibling rows and do not encode push order.
            sql`(
              (${draftWriteJournal.draftId} = ${draftId}
                AND ${draftWriteJournal.status} IN ('active', 'pushed'))
              OR (${draftWriteJournal.draftId} <> ${draftId}
                AND ${draftWriteJournal.status} = 'pushed')
            )`,
          ),
        )
        .orderBy(draftWriteJournal.id);
      return rows.map(({ row }) => mapJournalRow(row));
    },
  };
}

function mapJournalRow(row: JournalRecord): DraftJournalRow {
  return {
    id: row.id,
    draftId: row.draftId,
    wId: row.wId,
    toolCallId: row.toolCallId,
    source: row.source,
    threadId: row.threadId,
    turnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    draftBaseUpdateSeq: row.draftBaseUpdateSeq,
    status: row.status,
    updateMeta: row.updateMeta,
  };
}
