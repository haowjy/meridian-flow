/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited the text of that some tree view still shows, plus draft-scoped
 * edits of a document live deleted or in no view, whose drafts may outlive it (the inverse
 * decides from the draft row). Each draft-scoped target names the Work whose branch held the
 * draft (a text part's draft row), where it is read and reversed. Final address liveness stays
 * with the lineage reader. A tree change leaves no target: nothing reverses it.
 */

import { draftOwnerKey } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits } from "@meridian/database";
import { branches, documentDrafts } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { branchOwnerSql, ownerOfColumns } from "../../../shared/draft-owner.js";
import { livingDocumentSql } from "../../context/tree/living-document.js";
import type { TurnInverseQuery } from "../domain/turn-inverse-service.js";
import type { TurnEditedDocumentId } from "../domain/turn-live-lineage.js";

export async function readTurnEditTargets(
  db: Pick<Database, "selectDistinct">,
  query: TurnInverseQuery,
): Promise<TurnEditedDocumentId[]> {
  const owner = branchOwnerSql(branches);
  const rows = await db
    .selectDistinct({
      documentId: documentEdits.documentId,
      origin: documentEditParts.origin,
      branchId: branches.id,
      workId: owner.workId,
      rootThreadId: owner.rootThreadId,
      projectId: branches.projectId,
      handle: owner.handle,
    })
    .from(documentEdits)
    .leftJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    // A pending edit's Work: its draft row's branch (draft rows outlive Apply and Discard).
    .leftJoin(documentDrafts, sql`${documentDrafts.id} = ${documentEditParts.origin}->>'draftId'`)
    .leftJoin(branches, eq(branches.id, documentDrafts.branchId))
    .where(
      and(
        isNotNull(documentEditParts.id),
        // A draft-scoped edit keeps its history while the document's content is kept: a delete
        // in live or a discarded creation leaves the draft's bytes to retention.
        sql`(${livingDocumentSql(documentEdits.documentId)}
          OR (${documentEditParts.origin}->>'kind' = 'pending'
            AND exists (select 1 from documents d
              where d.id = ${documentEdits.documentId} and d.content_purged_at is null)))`,
        eq(documentEdits.threadId, query.threadId),
        query.turnId ? eq(documentEdits.turnId, query.turnId) : undefined,
        query.responseIdentity
          ? inArray(documentEdits.kind, ["write", "revert", "undo", "redo"])
          : inArray(documentEdits.kind, ["write", "revert"]),
        query.responseIdentity
          ? eq(documentEdits.responseId, query.responseIdentity.modelResponseId)
          : undefined,
        query.documentIds ? inArray(documentEdits.documentId, query.documentIds) : undefined,
      ),
    )
    .orderBy(documentEdits.documentId);
  const targets = new Map<string, TurnEditedDocumentId>();
  for (const row of rows) {
    // A receipt's destination never changes when its draft text is applied or discarded.
    const draft = row.origin?.kind === "pending";
    if (!draft) {
      targets.set(`${row.documentId}:live`, { documentId: row.documentId, scope: "live" });
      continue;
    }
    if (!row.branchId || !row.projectId) continue;
    const owner = ownerOfColumns({ ...row, projectId: row.projectId });
    if (!owner) continue;
    const ownerKey = draftOwnerKey(owner);
    const key = `${row.documentId}:draft:${ownerKey}`;
    const known = targets.get(key);
    if (known?.scope === "draft") {
      if (!known.branchIds.includes(row.branchId)) known.branchIds.push(row.branchId);
      continue;
    }
    targets.set(key, {
      documentId: row.documentId,
      scope: "draft",
      owner,
      ownerHandle: row.handle,
      branchIds: [row.branchId],
    });
  }
  return [...targets.values()].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || a.scope.localeCompare(b.scope),
  );
}
