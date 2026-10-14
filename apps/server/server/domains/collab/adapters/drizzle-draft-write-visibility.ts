/** Postgres reads and marks for the draft-write visibility check: a reply's pending parts and its Work draft. */
import { writeHandle } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits } from "@meridian/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type {
  DraftWriteVisibilityStore,
  ReplyDraftWrite,
} from "../domain/draft-write-visibility.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";

export function createDrizzleDraftWriteVisibilityStore(deps: {
  db: Database;
  branches: Pick<ApplicationBranchStore, "resolveWorkDraftBranchForThread">;
}): DraftWriteVisibilityStore {
  return {
    async readReplyWrites(input) {
      const rows = await currentDrizzleDb(deps.db)
        .select({
          partId: documentEditParts.id,
          update: documentEditParts.update,
          editId: documentEdits.id,
          wId: documentEdits.wId,
        })
        .from(documentEdits)
        .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
        .where(
          and(
            eq(documentEdits.threadId, input.threadId),
            eq(documentEdits.documentId, input.documentId),
            eq(documentEdits.editScopeId, input.editScopeId),
            eq(documentEdits.kind, "write"),
            sql`${documentEditParts.placement}->>'kind' = 'pending'`,
          ),
        )
        .orderBy(asc(documentEdits.createdAt), asc(documentEditParts.id));
      const writes = new Map<string, ReplyDraftWrite>();
      for (const row of rows) {
        const write = writes.get(row.editId) ?? {
          writeId: row.wId === null ? row.editId : writeHandle(row.wId),
          partIds: [],
          updates: [],
        };
        write.partIds.push(row.partId);
        write.updates.push(row.update);
        writes.set(row.editId, write);
      }
      return [...writes.values()];
    },

    async readDraft(input, read) {
      const draft = await deps.branches.resolveWorkDraftBranchForThread(
        input.documentId,
        input.threadId,
      );
      try {
        return read(draft.doc);
      } finally {
        draft.doc.destroy();
      }
    },

    async markInvisible(partIds) {
      if (partIds.length === 0) return;
      await currentDrizzleDb(deps.db)
        .update(documentEditParts)
        .set({ effect: sql`${documentEditParts.effect} || '{"invisible":true}'::jsonb` })
        .where(inArray(documentEditParts.id, [...partIds]));
    },
  };
}
