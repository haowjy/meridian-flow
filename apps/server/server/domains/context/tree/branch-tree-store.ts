/**
 * Reads and writes of `branch_tree_changes`: what one branch says about a node. A created row
 * holds identity and attribution (its place is the document row's, §6.2); a drafted move or
 * delete holds the branch's facts, which `writeBranchTreeFacts` alone writes. Folders are
 * implied by what a branch places under them (O-2).
 */
import type {
  BranchId,
  BranchTreeFacts,
  DocumentId,
  FolderId,
  ThreadId,
  TreePlacement,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branchTreeChanges, documentEdits } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { nextEditSeq } from "../../../shared/edit-history-seq.js";
import { tombstoneFolders } from "./node-rows.js";
import { loadFolderChains } from "./tree-addresses.js";
import type { NodeRef } from "./tree-view.js";
import { isUnusedHiddenFolder } from "./tree-view-sql.js";

/** The branch created (or joined) this document; its place is the document row's. The branch can't already have the row. */
export async function recordCreated(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  },
): Promise<void> {
  await currentDrizzleDb(db)
    .insert(branchTreeChanges)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      created: true,
      createdThreadId: input.createdBy?.threadId ?? null,
      createdTurnId: input.createdBy?.turnId ?? null,
    });
}

/** Who ended a branch's drafted entries, and how: the writer's Apply or Discard, or a cleanup. */
export type BranchSettlement = { as: "applied" | "discarded"; userId?: UserId | null };

/**
 * The branch stops saying anything about these documents: its rows go, and the drafted moves
 * and deletes they held are settled (`settleBranchEntries`), so a later undo of one refuses
 * as applied or discarded. Every terminal path ends a branch's facts here.
 */
export async function dropDocumentRows(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[]; settle: BranchSettlement },
): Promise<readonly NodeRef[]> {
  if (input.documentIds.length === 0) return [];
  await settleBranchEntries(db, input);
  const movedInto = await movedFolders(db, input.branchId, input.documentIds);
  await currentDrizzleDb(db)
    .delete(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.branchId, input.branchId),
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.nodeId, [...input.documentIds]),
      ),
    );
  // The hidden folders only its moves used go with them.
  return pruneHiddenFolders(db, movedInto);
}

/**
 * One settlement row per document naming every drafted entry (a move, delete or their
 * inverses) the branch recorded on it that no settlement ended yet (design-v2 §4). It mutates
 * nothing; the stack rules read it (`settlementOf`).
 */
export async function settleBranchEntries(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[]; settle: BranchSettlement },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const rows = await tx
    .select({
      editId: documentEdits.id,
      documentId: documentEdits.documentId,
      treeChange: documentEdits.treeChange,
    })
    .from(documentEdits)
    .where(
      and(
        inArray(documentEdits.documentId, [...input.documentIds]),
        sql`${documentEdits.treeChange}->'destination'->>'branchId' = ${input.branchId}`,
      ),
    );
  const settled = new Set(
    rows.flatMap((row) => (row.treeChange?.op === "settle" ? row.treeChange.settles.editIds : [])),
  );
  const open = new Map<DocumentId, string[]>();
  for (const row of rows)
    if (row.treeChange && row.treeChange.op !== "settle" && !settled.has(row.editId))
      open.set(row.documentId, [...(open.get(row.documentId) ?? []), row.editId]);
  for (const [documentId, editIds] of open)
    await tx.insert(documentEdits).values({
      documentId,
      actor: input.settle.userId ? "human" : "system",
      actorUserId: input.settle.userId ?? null,
      kind: "write",
      treeChange: {
        op: "settle",
        destination: { kind: "draft", branchId: input.branchId },
        shownAt: null,
        seq: await nextEditSeq(tx),
        targets: [],
        settles: { editIds, as: input.settle.as },
      },
    });
}

/** The folders a branch's moves put these documents in. */
async function movedFolders(
  db: Database,
  branchId: BranchId,
  documentIds: readonly DocumentId[],
): Promise<FolderId[]> {
  const rows = await currentDrizzleDb(db)
    .select({ folderId: branchTreeChanges.movedFolderId })
    .from(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.branchId, branchId),
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.nodeId, [...documentIds]),
      ),
    );
  return rows.flatMap((row) => (row.folderId ? [row.folderId as FolderId] : []));
}

/**
 * Tombstones the hidden folders in these folders' chains that nothing uses any more (no
 * living document or folder in them, no branch's move into them), bottom-up: a folder is
 * judged only after all of the batch's folders beneath it, so a sibling still alive at first
 * glance never leaves its parent behind. Visible folders are never touched.
 */
export async function pruneHiddenFolders(
  db: Database,
  folderIds: readonly (FolderId | null)[],
): Promise<NodeRef[]> {
  const tx = currentDrizzleDb(db);
  const chains = await loadFolderChains(
    tx,
    folderIds.filter((id): id is FolderId => id !== null),
  );
  const depthOf = new Map<FolderId, number>();
  for (const chain of chains.values()) {
    chain.forEach((folder, index) => {
      const depth = chain.length - index;
      depthOf.set(folder.id, Math.max(depthOf.get(folder.id) ?? 0, depth));
    });
  }
  const deepestFirst = [...depthOf.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const pruned: NodeRef[] = [];
  for (const folderId of deepestFirst) {
    if (!(await isUnusedHiddenFolder(tx, folderId))) continue;
    await tombstoneFolders(db, [folderId]);
    pruned.push({ kind: "folder", id: folderId });
  }
  return pruned;
}

const NO_FACTS: BranchTreeFacts = { row: false, created: false, moved: null, deleted: false };

/**
 * Each branch's facts about each document, as a tree entry records them: "no row" too, so
 * an inverse can tell a document that follows live from one moved to where live happens to be.
 */
export async function readBranchTreeFacts(
  db: Pick<DrizzleDb, "select">,
  branchIds: readonly BranchId[],
  documentIds: readonly DocumentId[],
): Promise<Map<BranchId, Map<DocumentId, BranchTreeFacts>>> {
  const out = new Map<BranchId, Map<DocumentId, BranchTreeFacts>>(
    branchIds.map((branchId) => [
      branchId,
      new Map(documentIds.map((documentId) => [documentId, NO_FACTS])),
    ]),
  );
  if (!branchIds.length || !documentIds.length) return out;
  const rows = await db
    .select({
      branchId: branchTreeChanges.branchId,
      nodeId: branchTreeChanges.nodeId,
      created: branchTreeChanges.created,
      moved: branchTreeChanges.moved,
      deleted: branchTreeChanges.deleted,
      folderId: branchTreeChanges.movedFolderId,
      rootSourceId: branchTreeChanges.movedRootSourceId,
      name: branchTreeChanges.movedName,
      extension: branchTreeChanges.movedExtension,
    })
    .from(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.branchId, [...branchIds]),
        inArray(branchTreeChanges.nodeId, [...documentIds]),
      ),
    );
  for (const row of rows)
    out.get(row.branchId)?.set(row.nodeId as DocumentId, {
      row: true,
      created: row.created,
      moved:
        row.moved && row.name !== null && row.extension !== null
          ? {
              folderId: row.folderId,
              rootSourceId: row.rootSourceId,
              name: row.name,
              extension: row.extension,
            }
          : null,
      deleted: row.deleted,
    });
  return out;
}

/**
 * Writes `facts` as the branch's row on a document: the one writer of drafted moves and
 * deletes, and of their inverses, which write back the facts an entry recorded. Every write
 * takes a new revision from the sequence (a value never recurs, so a frozen Apply click can
 * tell); the first `base_version` stays while a move or delete does. Facts that say nothing
 * remove the row: a document that follows live again. Created attribution is kept; the latest
 * move or delete's is `changedBy`. The caller holds the Work, the branch and the document lock.
 */
export async function writeBranchTreeFacts(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    facts: BranchTreeFacts;
    /** `documents.location_version` now: the base a first move or delete records. */
    locationVersion: bigint;
    changedBy: { threadId: ThreadId; turnId?: TurnId } | null;
  },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const { facts } = input;
  const key = and(
    eq(branchTreeChanges.branchId, input.branchId),
    eq(branchTreeChanges.nodeKind, "document"),
    eq(branchTreeChanges.nodeId, input.documentId),
  );
  if (!facts.row || !(facts.created || facts.moved || facts.deleted)) {
    await tx.delete(branchTreeChanges).where(key);
    return;
  }
  const changed = facts.moved !== null || facts.deleted;
  const moved: TreePlacement | null = facts.moved;
  const values = {
    created: facts.created,
    moved: moved !== null,
    movedFolderId: moved?.folderId ?? null,
    movedRootSourceId: moved?.folderId ? null : (moved?.rootSourceId ?? null),
    movedName: moved?.name ?? null,
    movedExtension: moved?.extension ?? null,
    deleted: facts.deleted,
    changedThreadId: changed ? (input.changedBy?.threadId ?? null) : null,
    changedTurnId: changed ? (input.changedBy?.turnId ?? null) : null,
  };
  await tx
    .insert(branchTreeChanges)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      ...values,
      baseVersion: changed ? input.locationVersion : null,
    })
    .onConflictDoUpdate({
      target: [branchTreeChanges.branchId, branchTreeChanges.nodeKind, branchTreeChanges.nodeId],
      set: {
        ...values,
        revision: sql`nextval('branch_tree_change_revision')`,
        baseVersion: changed
          ? sql`coalesce(${branchTreeChanges.baseVersion}, ${input.locationVersion}::bigint)`
          : null,
        updatedAt: new Date(),
      },
    });
}
