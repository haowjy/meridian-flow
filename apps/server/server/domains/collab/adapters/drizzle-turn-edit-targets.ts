/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited that are not tombstoned, plus draft-scoped edits of a document
 * deleted live, whose drafts may outlive the delete (the inverse decides from the draft
 * row), plus every document the turn moved or deleted, deleted or not: its tree entry is how
 * the card's Undo brings it back. Each draft-scoped target names the Work whose branch
 * held the draft (a text part's draft row, or a tree entry's destination branch), where it is
 * read and reversed. Final address liveness stays with the lineage reader.
 */

import { draftOwnerKey } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentEditParts, documentEdits } from "@meridian/database";
import { branches, documentDrafts } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { branchOwnerSql, ownerOfColumns } from "../../../shared/draft-owner.js";
import { livingOrOutlivedSql } from "../../context/tree/living-document.js";
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
      treeDestination: sql<
        "live" | "draft" | null
      >`${documentEdits.treeChange}->'destination'->>'kind'`,
      branchId: branches.id,
      workId: owner.workId,
      rootThreadId: owner.rootThreadId,
      projectId: branches.projectId,
      handle: owner.handle,
    })
    .from(documentEdits)
    .leftJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    // A pending edit's Work: its draft row's branch (draft rows outlive Apply and Discard); a
    // drafted tree entry's: the branch its destination names.
    .leftJoin(documentDrafts, sql`${documentDrafts.id} = ${documentEditParts.origin}->>'draftId'`)
    .leftJoin(
      branches,
      sql`${branches.id} = coalesce(${documentDrafts.branchId}, (${documentEdits.treeChange}->'destination'->>'branchId')::uuid)`,
    )
    .where(
      and(
        or(
          // Lineage hides tombstoned documents, and a Discarded branch-created one has no
          // storage left to lock. A delete keeps the bytes its surviving drafts' inverses plan
          // over.
          and(
            isNotNull(documentEditParts.id),
            livingOrOutlivedSql(
              documentEdits.documentId,
              sql`${documentEditParts.origin}->>'kind' = 'pending'`,
            ),
          ),
          isNotNull(documentEdits.treeChange),
        ),
        eq(documentEdits.threadId, query.threadId),
        query.turnId ? eq(documentEdits.turnId, query.turnId) : undefined,
        query.responseIdentity
          ? inArray(documentEdits.kind, ["write", "revert", "undo", "redo"])
          : inArray(documentEdits.kind, ["write", "revert"]),
        query.responseIdentity
          ? eq(documentEdits.responseId, query.responseIdentity.modelResponseId)
          : undefined,
        query.documentIds ? inArray(documentEdits.documentId, query.documentIds) : undefined,
        sql`NOT EXISTS (
          SELECT 1 FROM document_edits AS materialized
          WHERE materialized.document_id = ${documentEdits.documentId}
            AND materialized.tree_change->>'materializes' = ${documentEdits.id}::text
        )`,
      ),
    )
    .orderBy(documentEdits.documentId);
  const targets = new Map<string, TurnEditedDocumentId>();
  for (const row of rows) {
    // A receipt's destination never changes when its draft text is applied or discarded.
    const draft = row.origin ? row.origin.kind === "pending" : row.treeDestination === "draft";
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
