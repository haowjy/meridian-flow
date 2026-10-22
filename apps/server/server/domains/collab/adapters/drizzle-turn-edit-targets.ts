/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited that are not tombstoned, plus draft-scoped edits of a document
 * deleted live, whose drafts may outlive the delete (D79; the inverse decides from the draft
 * row). Final address liveness stays with the lineage reader.
 */
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits } from "@meridian/database";
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
    })
    .from(documentEdits)
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
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
    const scope = row.origin.kind === "pending" ? "draft" : "live";
    targets.set(`${row.documentId}:${scope}`, { documentId: row.documentId, scope });
  }
  return [...targets.values()].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || a.scope.localeCompare(b.scope),
  );
}
