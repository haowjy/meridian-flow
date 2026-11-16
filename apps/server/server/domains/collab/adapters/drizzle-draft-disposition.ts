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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type {
  DraftDispositionCapture,
  DraftDispositionStore,
  DraftReceiptPart,
} from "../domain/ports/draft-disposition-store.js";
import { readDraftsAt } from "./drizzle-draft-storage.js";
import { resolveEditOwners } from "./drizzle-edit-owners.js";

export function createDrizzleDraftDispositionStore(db: Database): DraftDispositionStore {
  const captureAll = (draftIds: readonly string[]) =>
    runInRootDrizzleReadSnapshot(db, async () => {
      const tx = currentDrizzleDb(db);
      const out = new Map<string, DraftDispositionCapture>();
      const drafts = [...(await readDraftsAt(tx, [...new Set(draftIds)])).values()].filter(
        (draft) => draft.documentDraft.kind === "work_draft",
      );
      if (drafts.length === 0) return out;
      const ids = drafts.map((draft) => draft.documentDraft.draftId);
      const projectRows = await tx
        .select({
          draftId: documentDrafts.id,
          userId: projects.userId,
          contentReleased: sql<boolean>`octet_length(${documentDrafts.state}) = 0 and octet_length(${documentDrafts.stateVector}) = 0`,
        })
        .from(documentDrafts)
        .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
        .innerJoin(projects, eq(projects.id, branches.projectId))
        .where(inArray(documentDrafts.id, ids));
      const project = new Map(projectRows.map((row) => [row.draftId, row]));
      const rows = await tx
        .select({
          draftId: sql<string>`${documentEditParts.origin}->>'draftId'`,
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
        .innerJoin(
          documentDrafts,
          and(
            sql`${documentDrafts.id} = ${documentEditParts.origin}->>'draftId'`,
            eq(documentDrafts.documentId, documentEdits.documentId),
          ),
        )
        .leftJoin(
          draftWriteJournal,
          sql`${draftWriteJournal.id} = (${documentEditParts.origin}->>'rowId')::bigint`,
        )
        .where(
          and(
            sql`${documentEditParts.origin}->>'kind' = 'pending'`,
            inArray(sql`${documentEditParts.origin}->>'draftId'`, ids),
            eq(documentEdits.actor, "agent"),
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
      const parts = new Map<string, DraftReceiptPart[]>();
      for (const row of rows) {
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
        const list = parts.get(row.draftId) ?? [];
        list.push({
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
        });
        parts.set(row.draftId, list);
      }
      for (const draft of drafts) {
        const id = draft.documentDraft.draftId;
        const found = project.get(id);
        if (!found) continue;
        // projects.user_id is the sole project user today, so no human receipt is read: the
        // captured snapshot proves the remainder.
        out.set(id, {
          draft,
          contentReleased: found.contentReleased,
          userId: found.userId,
          parts: parts.get(id) ?? [],
        });
      }
      return out;
    });
  return {
    captureAll,
    capture: async (draftId) => (await captureAll([draftId])).get(draftId) ?? null,
  };
}
