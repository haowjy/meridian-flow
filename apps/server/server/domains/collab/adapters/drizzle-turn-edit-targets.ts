/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited that are not tombstoned. Final address liveness stays with the lineage reader.
 */
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits, documents } from "@meridian/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { TurnInverseQuery } from "../domain/turn-inverse-service.js";
import type { TurnEditedDocumentId } from "../domain/turn-live-lineage.js";

export async function readTurnEditTargets(
  db: Pick<Database, "selectDistinct">,
  query: TurnInverseQuery,
): Promise<TurnEditedDocumentId[]> {
  const rows = await db
    .selectDistinct({
      documentId: documentEdits.documentId,
      placement: documentEditParts.placement,
      origin: documentEditParts.origin,
    })
    .from(documentEdits)
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    .innerJoin(documents, eq(documents.id, documentEdits.documentId))
    .where(
      and(
        // Lineage hides tombstoned documents, and a Discarded draft-created one has no storage left to lock.
        isNull(documents.deletedAt),
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
    // Terminal parts retain their historical view for the change viewer, never inverse eligibility.
    const placement =
      row.placement.kind === "live" || row.placement.kind === "pending"
        ? row.placement
        : row.origin;
    const scope = placement.kind === "pending" ? "draft" : "live";
    targets.set(`${row.documentId}:${scope}`, { documentId: row.documentId, scope });
  }
  return [...targets.values()].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || a.scope.localeCompare(b.scope),
  );
}
