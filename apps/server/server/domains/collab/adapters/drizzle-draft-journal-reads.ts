import type { Database } from "@meridian/database";
import { documentDrafts, draftWriteJournal, threads } from "@meridian/database/schema";
import { and, eq, gt, lte } from "drizzle-orm";
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
  updateMeta: draftWriteJournal.updateMeta,
};
type JournalRecord = Pick<typeof draftWriteJournal.$inferSelect, keyof typeof journalColumns>;

export function createDrizzleDraftReplayJournalReads(db: Database): DraftReplayJournalReads {
  return {
    async listConcurrentJournalRows(draftId, options) {
      // A save's attribution reads inside its own transaction: the root pool handle would
      // wait on another connection and miss that transaction's uncommitted rows.
      const rows = await currentDrizzleDb(db)
        .select({ row: journalColumns, threadHandle: threads.ref })
        .from(draftWriteJournal)
        .leftJoin(threads, eq(threads.id, draftWriteJournal.threadId))
        .innerJoin(documentDrafts, eq(draftWriteJournal.draftId, documentDrafts.id))
        .where(
          and(
            eq(documentDrafts.documentId, options.documentId),
            eq(draftWriteJournal.draftId, draftId),
            gt(draftWriteJournal.id, options.after),
            lte(draftWriteJournal.id, options.through),
          ),
        )
        .orderBy(draftWriteJournal.id);
      return rows.map(({ row, threadHandle }) => mapJournalRow(row, threadHandle));
    },
  };
}

function mapJournalRow(row: JournalRecord, threadHandle: string | null): DraftJournalRow {
  return {
    id: row.id,
    draftId: row.draftId,
    wId: row.wId,
    toolCallId: row.toolCallId,
    source: row.source,
    threadId: row.threadId,
    threadHandle,
    turnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    updateMeta: row.updateMeta,
  };
}
