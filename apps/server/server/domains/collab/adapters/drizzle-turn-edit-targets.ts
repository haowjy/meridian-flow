import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import type { DocumentId, DraftId } from "@meridian/contracts";
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

export const receiptDraftExists = or(isNull(treeEditReceipts.draftId), isNotNull(drafts.id));

export async function readTurnEditTargets(
  db: Pick<Database, "select">,
  query: TurnInverseQuery,
): Promise<TurnEditedDocumentId[]> {
  const owner = draftOwnerSql();
  const draftOf = sql<string | null>`${documentEditParts.origin}->>'draftId'`;
  const rows = await db
    .select({
      documentId: documentEdits.documentId,
      drafted: draftOf,
      draft: drafts.id,
      handle: owner.handle,
      delta: documentEditParts.delta,
    })
    .from(documentEdits)
    .innerJoin(documentEditParts, eq(documentEditParts.editId, documentEdits.id))
    .leftJoin(drafts, eq(drafts.id, draftOf))
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
    .orderBy(documentEdits.documentId, documentEditParts.id);
  const targets = new Map<string, TurnEditedDocumentId>();
  for (const row of rows) {
    if (row.drafted && !row.draft) continue;
    const key = `${row.documentId}:${row.drafted ?? "live"}`;
    const known = targets.get(key);
    if (known) {
      if (!known.block && row.delta) known.block = firstChangedBlock(row.delta);
      continue;
    }
    const block = row.delta ? firstChangedBlock(row.delta) : undefined;
    targets.set(
      key,
      row.draft
        ? {
            documentId: row.documentId,
            scope: "draft",
            draft: row.draft as DraftId,
            ownerHandle: row.handle,
            ...(block ? { block } : {}),
          }
        : { documentId: row.documentId, scope: "live", ...(block ? { block } : {}) },
    );
  }
  return [...targets.values()];
}

/**
 * The first block a write's delta changed, by id: one it put in or changed, or for a write that
 * only took blocks out, the block after them. The delta keeps one unchanged block either side.
 */
function firstChangedBlock(delta: StoredDelta): string | undefined {
  const idOf = (block: Record<string, unknown>) => (block.attrs as { id?: string } | undefined)?.id;
  const before = new Map(delta.before.map((block) => [idOf(block), JSON.stringify(block)]));
  const changed = delta.after.find((block) => before.get(idOf(block)) !== JSON.stringify(block));
  const at = changed ?? delta.after[1] ?? delta.after[0];
  return at ? idOf(at) : undefined;
}

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
    .leftJoin(drafts, eq(drafts.id, treeEditReceipts.draftId))
    .where(
      and(
        eq(treeEditReceipts.threadId, query.threadId),
        eq(treeEditReceipts.turnId, query.turnId),
        eq(treeEditReceipts.kind, "write"),
        isNull(documents.id),
        receiptDraftExists,
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

export async function readTurnTreeTargets(
  db: Pick<Database, "selectDistinct">,
  query: {
    threadId: TurnInverseQuery["threadId"];
    turnId: NonNullable<TurnInverseQuery["turnId"]>;
  },
  known: readonly TurnEditedDocumentId[],
): Promise<TurnEditedDocumentId[]> {
  const owner = draftOwnerSql();
  const rows = await db
    .selectDistinct({
      documentId: treeEditReceiptNodes.nodeId,
      draft: drafts.id,
      handle: owner.handle,
    })
    .from(treeEditReceipts)
    .innerJoin(treeEditReceiptNodes, eq(treeEditReceiptNodes.receiptId, treeEditReceipts.id))
    .innerJoin(documents, eq(documents.id, treeEditReceiptNodes.nodeId))
    .leftJoin(drafts, eq(drafts.id, treeEditReceipts.draftId))
    .where(
      and(
        eq(treeEditReceipts.threadId, query.threadId),
        eq(treeEditReceipts.turnId, query.turnId),
        eq(treeEditReceipts.kind, "write"),
        receiptDraftExists,
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
