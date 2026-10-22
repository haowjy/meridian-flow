/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited that are not tombstoned, plus draft-scoped edits of a document
 * deleted live, whose drafts may outlive the delete (D79; the inverse decides from the draft
 * row). Each draft-scoped target names the Work whose branch held the draft, where it is
 * read and reversed. Final address liveness stays with the lineage reader.
 */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits } from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { livingOrOutlivedSql } from "../../context/tree/living-document.js";
import type { TurnInverseQuery } from "../domain/turn-inverse-service.js";
import type { TurnEditedDocumentId } from "../domain/turn-live-lineage.js";

export async function readTurnEditTargets(
  db: Pick<Database, "selectDistinct">,
  query: TurnInverseQuery,
): Promise<TurnEditedDocumentId[]> {
  const rows = await db
    .selectDistinct({
      documentId: documentEdits.documentId,
      origin: documentEditParts.origin,
      workId: works.id,
      workHandle: works.handle,
      isNoWork: works.isNoWork,
    })
    .from(documentEdits)
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    // A pending edit's Work: its draft row's branch. Draft rows outlive Apply and Discard.
    .leftJoin(documentDrafts, sql`${documentDrafts.id} = ${documentEditParts.origin}->>'draftId'`)
    .leftJoin(branches, eq(branches.id, documentDrafts.branchId))
    .leftJoin(works, eq(works.id, branches.originWorkId))
    .where(
      and(
        // Lineage hides tombstoned documents, and a Discarded branch-created one has no storage
        // left to lock. A delete keeps the bytes its surviving drafts' inverses plan over.
        livingOrOutlivedSql(
          documentEdits.documentId,
          sql`${documentEditParts.origin}->>'kind' = 'pending'`,
        ),
        eq(documentEdits.threadId, query.threadId),
        query.turnId ? eq(documentEdits.turnId, query.turnId) : undefined,
        query.responseIdentity
          ? inArray(documentEdits.kind, ["write", "revert", "undo", "redo"])
          : inArray(documentEdits.kind, ["write", "revert"]),
        query.responseIdentity
          ? eq(documentEdits.editScopeId, query.responseIdentity.editScopeId)
          : undefined,
        query.documentIds ? inArray(documentEdits.documentId, query.documentIds) : undefined,
      ),
    )
    .orderBy(documentEdits.documentId);
  const targets = new Map<string, TurnEditedDocumentId>();
  for (const row of rows) {
    // A receipt's destination never changes when its draft text is applied or discarded.
    if (row.origin.kind === "live") {
      targets.set(`${row.documentId}:live`, { documentId: row.documentId, scope: "live" });
      continue;
    }
    if (!row.workId) continue;
    targets.set(`${row.documentId}:draft:${row.workId}`, {
      documentId: row.documentId,
      scope: "draft",
      work: { id: row.workId as WorkId, handle: row.isNoWork ? null : row.workHandle },
    });
  }
  return [...targets.values()].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || a.scope.localeCompare(b.scope),
  );
}
