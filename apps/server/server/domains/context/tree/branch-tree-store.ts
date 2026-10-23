/**
 * Reads and writes of `branch_tree_changes`: what one branch says about a node. A created row
 * holds identity and attribution (its place is the document row's, §6.2); a drafted move or
 * delete holds the branch's facts, which `writeBranchTreeFacts` alone writes. Folders are
 * implied by what a branch places under them (O-2).
 */
import type {
  BranchId,
  BranchTreeFacts,
  ContextSourceId,
  DocumentId,
  FolderId,
  ThreadId,
  TreePlacement,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  branchTreeChanges,
  branchTreeFolders,
  branchTreeUnsettled,
  documentEdits,
  folders,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { nextEditSeq } from "../../../shared/edit-history-seq.js";
import {
  isTransitionEntry,
  latestTransition,
  type StoredTreeEntry,
} from "../../collab/domain/tree-inverse.js";
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

/**
 * A text-only Apply revealed the branch's creation: the branch no longer creates it, while a
 * move or delete it drafted stays pending on the now-live document (design-v2 §4), with a new
 * revision so a tree cut frozen before answers `changed`. A row that said nothing more goes.
 */
export async function endCreatedFact(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const key = and(
    eq(branchTreeChanges.branchId, input.branchId),
    eq(branchTreeChanges.nodeKind, "document"),
    eq(branchTreeChanges.nodeId, input.documentId),
  );
  await tx
    .delete(branchTreeChanges)
    .where(and(key, eq(branchTreeChanges.moved, false), eq(branchTreeChanges.deleted, false)));
  await tx
    .update(branchTreeChanges)
    .set({
      created: false,
      createdThreadId: null,
      createdTurnId: null,
      revision: sql`nextval('branch_tree_change_revision')`,
      updatedAt: new Date(),
    })
    .where(key);
}

/**
 * A different branch revealed a creation this branch had hidden again by undoing its create.
 * The undo no longer means a delete of the now-live document; only an independent move remains.
 */
export async function settleUndoneCreatesAfterReveal(
  db: Database,
  documentId: DocumentId,
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const undone = and(
    eq(branchTreeChanges.nodeKind, "document"),
    eq(branchTreeChanges.nodeId, documentId),
    eq(branchTreeChanges.created, true),
    eq(branchTreeChanges.deleted, true),
  );
  await tx.delete(branchTreeChanges).where(and(undone, eq(branchTreeChanges.moved, false)));
  await tx
    .update(branchTreeChanges)
    .set({
      created: false,
      createdThreadId: null,
      createdTurnId: null,
      deleted: false,
      revision: sql`nextval('branch_tree_change_revision')`,
      updatedAt: new Date(),
    })
    .where(undone);
}

/** Who ended a branch's drafted entries, and how: the writer's Apply or Discard, or a cleanup. */
export type BranchSettlement = { as: "applied" | "discarded"; userId?: UserId | null };

/**
 * The branch stops saying anything about these documents: its drafted moves and deletes are
 * settled (`settleBranchEntries`, which prunes the folders they held), then its rows go. Every
 * terminal path that drops a branch's rows ends them here.
 */
export async function dropDocumentRows(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[]; settle: BranchSettlement },
): Promise<readonly NodeRef[]> {
  if (input.documentIds.length === 0) return [];
  const pruned = await settleBranchEntries(db, input);
  await currentDrizzleDb(db)
    .delete(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.branchId, input.branchId),
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.nodeId, [...input.documentIds]),
      ),
    );
  return pruned;
}

/**
 * The one settlement of a branch's drafted entries (design-v2 §4): per document, the stack
 * entries (moves, deletes and reverts; never the undo, redo or rollback rows that reversed them)
 * the branch recorded on it that no settlement ended yet. Those still in effect settle as the
 * caller says; those undone settle as discarded, since the proposal they belonged to ended
 * without them (a later redo answers so rather than proposing them again); those a rollback
 * reversed are not named, their rollback ended them. Then the folders the entries held
 * (`branch_tree_folders`) are released and the hidden ones nothing else uses are pruned. The row
 * itself is the caller's: it drops it or keeps only a creation. The caller holds the tree scope
 * of the branch's documents (`acquireTreeScope`), which covers every held folder's namespace.
 */
export async function settleBranchEntries(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[]; settle: BranchSettlement },
): Promise<NodeRef[]> {
  if (input.documentIds.length === 0) return [];
  const tx = currentDrizzleDb(db);
  const rows = await tx
    .select({
      editId: documentEdits.id,
      documentId: documentEdits.documentId,
      kind: documentEdits.kind,
      treeChange: documentEdits.treeChange,
    })
    .from(documentEdits)
    .where(
      and(
        inArray(documentEdits.documentId, [...input.documentIds]),
        sql`${documentEdits.treeChange}->'destination'->>'branchId' = ${input.branchId}`,
      ),
    );
  const byDocument = new Map<DocumentId, TreeRow[]>();
  for (const row of rows)
    if (row.treeChange)
      byDocument.set(row.documentId, [
        ...(byDocument.get(row.documentId) ?? []),
        {
          id: row.treeChange.seq,
          editId: row.editId,
          kind: row.kind,
          targets: row.treeChange.targets,
          tree: row.treeChange,
        },
      ]);
  for (const [documentId, history] of byDocument) {
    history.sort((a, b) => a.id - b.id);
    const { effective, undone } = unsettledEntries(history);
    const settlements: [BranchSettlement["as"], string[]][] =
      input.settle.as === "applied"
        ? [
            ["applied", effective],
            ["discarded", undone],
          ]
        : [["discarded", [...effective, ...undone]]];
    for (const [as, editIds] of settlements)
      if (editIds.length)
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
            settles: { editIds, as },
          },
        });
  }
  const scoped = and(
    eq(branchTreeUnsettled.branchId, input.branchId),
    inArray(branchTreeUnsettled.documentId, [...input.documentIds]),
  );
  await tx.delete(branchTreeUnsettled).where(scoped);
  const released = await tx
    .delete(branchTreeFolders)
    .where(
      and(
        eq(branchTreeFolders.branchId, input.branchId),
        inArray(branchTreeFolders.documentId, [...input.documentIds]),
      ),
    )
    .returning({ folderId: branchTreeFolders.folderId });
  return pruneHiddenFolders(db, [...new Set(released.map((row) => row.folderId))]);
}

type TreeRow = Pick<StoredTreeEntry, "id" | "editId" | "kind" | "targets" | "tree">;

/**
 * One document's unsettled stack entries in one branch, split by whether their effect stands
 * (`latestTransition`, the rule the inverses judge by). `history` is ordered by `seq`.
 */
function unsettledEntries(history: readonly TreeRow[]): { effective: string[]; undone: string[] } {
  const settled = new Set(
    history.flatMap((row) => (row.tree.op === "settle" ? row.tree.settles.editIds : [])),
  );
  const rolledBack = new Set(
    history.flatMap((row) =>
      row.kind === "rollback" ? row.targets.map((target) => target.editId) : [],
    ),
  );
  const effective: string[] = [];
  const undone: string[] = [];
  for (const row of history) {
    if (!isTransitionEntry(row) || settled.has(row.editId) || rolledBack.has(row.editId)) continue;
    if (row.kind !== "write" && row.kind !== "revert") continue;
    (latestTransition(row, history, new Set()).stands ? effective : undone).push(row.editId);
  }
  return { effective, undone };
}

/**
 * Tombstones the hidden folders in these folders' chains that nothing uses any more (no
 * living document or folder in them, no branch holding them for a drafted move), bottom-up: a folder is
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

/**
 * What a branch's cleanup must lock for its unsettled entries (all its documents', or these):
 * the documents they are on, wherever its row has them now or whether it has one, and the source
 * each folder they hold sits in now, which settlement may prune.
 */
export async function readBranchHolds(
  db: Pick<DrizzleDb, "select">,
  branchId: BranchId,
  documentIds?: readonly DocumentId[],
): Promise<{ documentIds: DocumentId[]; sourceIds: ContextSourceId[] }> {
  if (documentIds?.length === 0) return { documentIds: [], sourceIds: [] };
  const unsettled = await db
    .select({ documentId: branchTreeUnsettled.documentId })
    .from(branchTreeUnsettled)
    .where(
      and(
        eq(branchTreeUnsettled.branchId, branchId),
        documentIds ? inArray(branchTreeUnsettled.documentId, [...documentIds]) : undefined,
      ),
    );
  const held = await db
    .select({ contextSourceId: folders.contextSourceId })
    .from(branchTreeFolders)
    .innerJoin(folders, eq(folders.id, branchTreeFolders.folderId))
    .where(
      and(
        eq(branchTreeFolders.branchId, branchId),
        documentIds ? inArray(branchTreeFolders.documentId, [...documentIds]) : undefined,
      ),
    );
  return {
    documentIds: unsettled.map((row) => row.documentId),
    sourceIds: held.map((row) => row.contextSourceId),
  };
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
 * move or delete's is `changedBy`. A moved fact's folder is held (`branch_tree_folders`) until
 * settlement, so an undo back into it finds it and cleanup prunes it. The caller holds the Work, the branch and the document lock.
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
    /** Reinstates attribution when a creation inverse recreates its deleted facts row. */
    createdBy?: { threadId: ThreadId; turnId?: TurnId } | null;
  },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const { facts } = input;
  const key = and(
    eq(branchTreeChanges.branchId, input.branchId),
    eq(branchTreeChanges.nodeKind, "document"),
    eq(branchTreeChanges.nodeId, input.documentId),
  );
  // Every facts write is a drafted tree entry's: it stays to settle wherever the row goes.
  await tx
    .insert(branchTreeUnsettled)
    .values({ branchId: input.branchId, documentId: input.documentId })
    .onConflictDoNothing();
  if (!facts.row || !(facts.created || facts.moved || facts.deleted)) {
    await tx.delete(branchTreeChanges).where(key);
    return;
  }
  const changed = facts.moved !== null || facts.deleted;
  const moved: TreePlacement | null = facts.moved;
  const values = {
    created: facts.created,
    ...(input.createdBy
      ? {
          createdThreadId: input.createdBy.threadId,
          createdTurnId: input.createdBy.turnId ?? null,
        }
      : {}),
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
  // Held until the branch's entries on the document settle, wherever its row goes since.
  if (moved?.folderId)
    await tx
      .insert(branchTreeFolders)
      .values({
        branchId: input.branchId,
        documentId: input.documentId,
        folderId: moved.folderId as FolderId,
      })
      .onConflictDoNothing();
}
