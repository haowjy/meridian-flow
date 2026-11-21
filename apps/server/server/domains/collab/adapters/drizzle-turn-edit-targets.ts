/**
 * Canonical immutable turn targets shared by authorization, lineage and inverse admission:
 * documents the turn edited the text of that some tree view still shows. Every text edit is in
 * Live (a Work's are suggestions there). Final address liveness stays with the lineage reader.
 * A tree change leaves no text target;
 * `readTurnTreeTargets` lists the documents a reply only moved, created or deleted, for its card.
 */

import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  documentEditParts,
  documentEdits,
  documents,
  treeEditReceiptNodes,
  treeEditReceipts,
} from "@meridian/database";
import { drafts } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { draftOwnerSql } from "../../../shared/draft-owner.js";
import { livingDocumentSql } from "../../context/tree/living-document.js";
import type { TurnInverseQuery } from "../domain/turn-inverse-service.js";
import type { TurnEditedDocumentId, TurnFolderTarget } from "../domain/turn-live-lineage.js";

/**
 * A receipt drafted in a draft a Work purge deleted has nothing left to show: reading its missing
 * draft as none would list the edit as live.
 */
export const receiptBranchExists = or(isNull(treeEditReceipts.draftBranchId), isNotNull(drafts.id));

export async function readTurnEditTargets(
  db: Pick<Database, "selectDistinct">,
  query: TurnInverseQuery,
): Promise<TurnEditedDocumentId[]> {
  const rows = await db
    .selectDistinct({ documentId: documentEdits.documentId })
    .from(documentEdits)
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    .where(
      and(
        livingDocumentSql(documentEdits.documentId),
        eq(documentEdits.threadId, query.threadId),
        query.turnId ? eq(documentEdits.turnId, query.turnId) : undefined,
        query.responseIdentity
          ? inArray(documentEdits.kind, ["write", "revert", "undo"])
          : inArray(documentEdits.kind, ["write", "revert"]),
        query.responseIdentity
          ? eq(documentEdits.responseId, query.responseIdentity.modelResponseId)
          : undefined,
        query.documentIds ? inArray(documentEdits.documentId, query.documentIds) : undefined,
      ),
    )
    .orderBy(documentEdits.documentId);
  return rows.map((row) => ({ documentId: row.documentId, scope: "live" as const }));
}

/**
 * The folders the turn's tree receipts changed, live or in the branch the change was drafted in,
 * whether or not the card's Undo has since taken them back: a folder has no document, and the
 * reply's card lists it all the same. Each is named by the path the receipt recorded. Only the
 * turn's own writes say where it wrote: a Redo of an applied draft lands live, and read as a
 * target it would list the folder a second time, live.
 */
export async function readTurnFolderTargets(
  db: Pick<Database, "selectDistinct">,
  query: {
    threadId: TurnInverseQuery["threadId"];
    turnId: NonNullable<TurnInverseQuery["turnId"]>;
  },
): Promise<TurnFolderTarget[]> {
  const rows = await db
    .selectDistinct({
      nodeId: treeEditReceiptNodes.nodeId,
      shownAt: sql<string>`coalesce(${treeEditReceiptNodes.afterAt}, ${treeEditReceiptNodes.beforeAt}, ${treeEditReceipts.shownAt})`,
      draft: drafts.id,
    })
    .from(treeEditReceipts)
    .innerJoin(treeEditReceiptNodes, eq(treeEditReceiptNodes.receiptId, treeEditReceipts.id))
    .leftJoin(documents, eq(documents.id, treeEditReceiptNodes.nodeId))
    .leftJoin(drafts, eq(drafts.id, treeEditReceipts.draftBranchId))
    .where(
      and(
        eq(treeEditReceipts.threadId, query.threadId),
        eq(treeEditReceipts.turnId, query.turnId),
        eq(treeEditReceipts.kind, "write"),
        isNull(documents.id),
        receiptBranchExists,
      ),
    )
    .orderBy(treeEditReceiptNodes.nodeId);
  const folders = new Map<string, TurnFolderTarget>();
  for (const row of rows)
    if (row.shownAt)
      folders.set(`${row.nodeId}:${row.draft}`, {
        nodeId: row.nodeId,
        draft: row.draft,
        shownAt: row.shownAt,
      });
  return [...folders.values()];
}

/**
 * The documents the turn's tree receipts changed (a folder has no document), live or in the
 * branch the change was drafted in, whether or not the card's Undo has since taken them back.
 * Merged into `known` where a text edit already lists the same destination.
 */
export async function readTurnTreeTargets(
  db: Pick<Database, "selectDistinct">,
  query: {
    threadId: TurnInverseQuery["threadId"];
    turnId: NonNullable<TurnInverseQuery["turnId"]>;
  },
  known: readonly TurnEditedDocumentId[],
): Promise<TurnEditedDocumentId[]> {
  const owner = draftOwnerSql(drafts.id);
  const rows = await db
    .selectDistinct({
      documentId: treeEditReceiptNodes.nodeId,
      draft: drafts.id,
      handle: owner.handle,
    })
    .from(treeEditReceipts)
    .innerJoin(treeEditReceiptNodes, eq(treeEditReceiptNodes.receiptId, treeEditReceipts.id))
    .innerJoin(documents, eq(documents.id, treeEditReceiptNodes.nodeId))
    .leftJoin(drafts, eq(drafts.id, treeEditReceipts.draftBranchId))
    .where(
      and(
        eq(treeEditReceipts.threadId, query.threadId),
        eq(treeEditReceipts.turnId, query.turnId),
        // Write receipts only: a Redo's names where it landed (live after an Apply), not where the turn wrote.
        eq(treeEditReceipts.kind, "write"),
        receiptBranchExists,
      ),
    );
  const targets = new Map<string, TurnEditedDocumentId>();
  const keyOf = (target: TurnEditedDocumentId) =>
    target.scope === "draft"
      ? `${target.documentId}:draft:${target.draft}`
      : `${target.documentId}:live`;
  for (const target of known) targets.set(keyOf(target), target);
  for (const row of rows) {
    const documentId = row.documentId as DocumentId;
    const target: TurnEditedDocumentId = row.draft
      ? { documentId, scope: "draft", draft: row.draft, ownerHandle: row.handle }
      : { documentId, scope: "live" };
    if (!targets.has(keyOf(target))) targets.set(keyOf(target), target);
  }
  return [...targets.values()].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || a.scope.localeCompare(b.scope),
  );
}
