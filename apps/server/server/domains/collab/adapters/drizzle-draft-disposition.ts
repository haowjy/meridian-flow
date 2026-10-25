/** Repeatable-read historical draft evidence, indexed by immutable receipt origin, never placement. */
import type { ItemRange } from "@meridian/agent-edit/diff";
import {
  branches,
  type Database,
  documentDrafts,
  documentEditParts,
  documentEdits,
  draftWriteJournal,
  projects,
} from "@meridian/database";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DraftDispositionStore } from "../domain/ports/draft-disposition-store.js";
import { readDraftAt } from "./drizzle-draft-storage.js";
import { resolveEditOwners } from "./drizzle-edit-owners.js";

export function createDrizzleDraftDispositionStore(db: Database): DraftDispositionStore {
  return {
    capture: (draftId) =>
      runInRootDrizzleReadSnapshot(db, async () => {
        const tx = currentDrizzleDb(db);
        const draft = await readDraftAt(tx, draftId);
        if (draft?.documentDraft.kind !== "work_draft") return null;
        const [project] = await tx
          .select({
            userId: projects.userId,
            contentReleased: sql<boolean>`octet_length(${documentDrafts.state}) = 0 and octet_length(${documentDrafts.stateVector}) = 0`,
          })
          .from(documentDrafts)
          .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
          .innerJoin(projects, eq(projects.id, branches.projectId))
          .where(eq(documentDrafts.id, draftId));
        if (!project) return null;
        const rows = await tx
          .select({
            id: documentEditParts.id,
            editId: documentEditParts.editId,
            ordinal: documentEditParts.ordinal,
            origin: documentEditParts.origin,
            effect: documentEditParts.effect,
            threadId: documentEdits.threadId,
            turnId: documentEdits.turnId,
            toolCallId: draftWriteJournal.toolCallId,
          })
          .from(documentEditParts)
          .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
          .leftJoin(
            draftWriteJournal,
            sql`${draftWriteJournal.id} = (${documentEditParts.origin}->>'rowId')::bigint`,
          )
          .where(
            and(
              sql`${documentEditParts.origin}->>'kind' = 'pending'`,
              sql`${documentEditParts.origin}->>'draftId' = ${draftId}`,
              eq(documentEdits.actor, "agent"),
              eq(documentEdits.documentId, draft.documentDraft.documentId),
            ),
          )
          .orderBy(desc(documentEdits.createdAt), desc(documentEditParts.id));
        const owners = await resolveEditOwners(
          tx,
          rows.flatMap((row) => (row.threadId ? [row.threadId] : [])),
        );
        const tuple = (range: { client: number; clock: number; len: number }): ItemRange => [
          range.client,
          range.clock,
          range.len,
        ];
        return {
          draft,
          contentReleased: project.contentReleased,
          userId: project.userId,
          parts: rows.map((row) => {
            const resolved = row.threadId ? owners.get(row.threadId) : undefined;
            const owner =
              row.threadId && row.turnId
                ? {
                    threadId: resolved?.threadId ?? row.threadId,
                    title: resolved?.title ?? "",
                    reveal: resolved?.spawn ?? {
                      threadId: row.threadId,
                      turnId: row.turnId,
                      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
                    },
                  }
                : null;
            return {
              id: row.id,
              editId: row.editId,
              ordinal: row.ordinal,
              origin: row.origin,
              threadId: owner?.threadId ?? row.threadId,
              turnId: owner?.reveal.turnId ?? row.turnId,
              ...(owner?.reveal.toolCallId ? { toolCallId: owner.reveal.toolCallId } : {}),
              inserted: row.effect.inserted.map(tuple),
              deleted: row.effect.deleted.map(tuple),
              owner,
            };
          }),
          // projects.user_id is the sole project user today. Even explicit writerRanges
          // requests need no human receipt query: the captured snapshot proves the remainder.
        };
      }),
  };
}
