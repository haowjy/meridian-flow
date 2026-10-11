/**
 * Live folder normalization (contract §8.2, §8.3): write-time repairs that keep a draft's
 * hidden contents where that draft placed them when the writer renames, moves or deletes
 * a live folder. A visible folder arriving at a hidden folder's path absorbs it; a delete
 * or a move out of the project splits hidden contents off into hidden twins at their old
 * paths. Change rows naming an absorbed or split folder follow it.
 *
 * Every function runs in its caller's transaction, which holds the namespace locks of
 * every source involved; every draft tree write takes those too, so nothing a draft
 * writes can interleave. No draft lock is taken here.
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents, draftTreeChanges, folders } from "@meridian/database/schema";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { insertFolder, tombstoneFolders } from "./node-rows.js";
import { treeHook } from "./test-hooks.js";
import type { NodeRef } from "./tree-view.js";
import {
  findHiddenFolder,
  loadFolderIdentityRows,
  loadSubtreeNodes,
  type SplitBoundary,
  type SubtreeNode,
} from "./tree-view-sql.js";

/**
 * A live folder landed at a hidden folder's path: fold the hidden one into it, recursively
 * (§8.2). Same-named child folders fold into each other; everything else is reparented.
 * Nothing is refused: a hidden node that lands beside a node of the other kind stays
 * hidden there; the tree view owns the clash the drafts that use it see (F11).
 */
export async function absorbHiddenFolder(
  db: Database,
  input: { hidden: FolderId; into: FolderId },
): Promise<void> {
  await treeHook("absorb.beforeRepoint");
  await fold(db, input.hidden, input.into);
}

/** Find and absorb every hidden folder at a visible folder's own path. */
export async function absorbAt(db: Database, folder: FolderId): Promise<void> {
  const [row] = await loadFolderIdentityRows(currentDrizzleDb(db), [folder]);
  if (!row || row.hidden || row.deleted) return;
  for (;;) {
    const hidden = await findHiddenFolder(db, row);
    if (!hidden) break;
    await absorbHiddenFolder(db, { hidden, into: folder });
  }
}

async function fold(db: Database, hidden: FolderId, into: FolderId): Promise<void> {
  const tx = currentDrizzleDb(db);
  const now = new Date();
  const children = await tx
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(and(eq(folders.parentId, hidden), isNull(folders.deletedAt)))
    .orderBy(asc(folders.id));
  for (const child of children) {
    const [twin] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.parentId, into),
          eq(folders.name, child.name),
          isNull(folders.deletedAt),
          ne(folders.id, child.id),
        ),
      )
      .orderBy(asc(folders.createdAt), asc(folders.id))
      .limit(1);
    if (twin) {
      await fold(db, child.id, twin.id);
    } else {
      // Also when `into` holds a document of this name: the pair is a collision, not a refusal.
      await tx
        .update(folders)
        .set({ parentId: into, updatedAt: now })
        .where(eq(folders.id, child.id));
    }
  }
  // A hidden folder holds only hidden nodes (TM invariant 2). Their paths are unchanged in
  // every view, so no rendered token moves and no version is bumped.
  await tx
    .update(documents)
    .set({ folderId: into, updatedAt: now })
    .where(and(eq(documents.folderId, hidden), isNull(documents.deletedAt)));
  await tx
    .update(draftTreeChanges)
    .set({ parentFolderId: into, updatedAt: now })
    .where(eq(draftTreeChanges.parentFolderId, hidden));
  await tombstoneFolders(db, [hidden]);
}

export type SplitResult = {
  /** Each folder of the ancestor-closed set → its new hidden twin. */
  twins: ReadonlyMap<FolderId, FolderId>;
  /** The boundary hidden nodes, now under twins (their hidden subtrees came along). */
  movedHidden: readonly NodeRef[];
};

/** A folder as the snapshot saw it, before anything moved. */
export type SplitFolder = {
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
};

/**
 * What a split will write, decided from a snapshot taken before any write (F19): twins
 * root to leaf at their originals' coordinates, the boundary nodes to move under them,
 * and the folders whose change rows follow their twins.
 */
export type SplitPlan = {
  twins: readonly {
    original: FolderId;
    contextSourceId: ContextSourceId;
    /** Another twin of this plan, or a folder that stays where it is. */
    parent: { twinOf: FolderId } | { folder: FolderId | null };
    name: string;
  }[];
  boundaries: readonly SplitBoundary[];
  repoint: readonly FolderId[];
};

/**
 * The ancestor-closed twin set (§8.3, B6) over a snapshot: every boundary parent, then
 * each twinned folder's parent while that parent leaves its path too (a deleted or split
 * root's own ancestors, or a folder another move of the same batch carries away). Only
 * folders whose own hidden contents split off (`splits`) repoint their change rows; a
 * moving ancestor twinned only to anchor the path keeps its rows, which move with it.
 */
export function planSplit(input: {
  folders: ReadonlyMap<FolderId, SplitFolder>;
  boundaries: readonly SplitBoundary[];
  leaves(folder: FolderId): boolean;
  splits(folder: FolderId): boolean;
}): SplitPlan {
  const set = new Set<FolderId>();
  const pending = input.boundaries.map((boundary) => boundary.parentId);
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    if (set.has(folder)) continue;
    set.add(folder);
    const parent = input.folders.get(folder)?.parentId ?? null;
    if (parent && input.folders.has(parent) && input.leaves(parent)) pending.push(parent);
  }
  const depth = (folder: FolderId): number => {
    const parent = input.folders.get(folder)?.parentId ?? null;
    return parent && set.has(parent) ? depth(parent) + 1 : 0;
  };
  return {
    twins: [...set]
      .sort((a, b) => depth(a) - depth(b))
      .map((original) => {
        const folder = input.folders.get(original) as SplitFolder;
        return {
          original,
          contextSourceId: folder.contextSourceId,
          parent:
            folder.parentId && set.has(folder.parentId)
              ? { twinOf: folder.parentId }
              : { folder: folder.parentId },
          name: folder.name,
        };
      }),
    boundaries: input.boundaries,
    repoint: [...set].filter((folder) => input.splits(folder)),
  };
}

/** Writes a split plan: twins, boundary nodes under them, change rows after them. */
export async function applySplit(db: Database, plan: SplitPlan): Promise<SplitResult> {
  await treeHook("split.beforeRepoint");
  const tx = currentDrizzleDb(db);
  const twins = new Map<FolderId, FolderId>();
  for (const twin of plan.twins) {
    const parentId =
      "twinOf" in twin.parent ? (twins.get(twin.parent.twinOf) as FolderId) : twin.parent.folder;
    twins.set(
      twin.original,
      // TM invariant 5: the original leaves its path in this transaction, so the twin
      // shares it with nothing visible.
      await insertFolder(
        db,
        { contextSourceId: twin.contextSourceId, parentId, name: twin.name },
        { hidden: true },
      ),
    );
  }
  const now = new Date();
  for (const boundary of plan.boundaries) {
    const twin = twins.get(boundary.parentId) as FolderId;
    if (boundary.kind === "document") {
      await tx
        .update(documents)
        .set({ folderId: twin, updatedAt: now })
        .where(eq(documents.id, boundary.id));
    } else {
      await tx
        .update(folders)
        .set({ parentId: twin, updatedAt: now })
        .where(eq(folders.id, boundary.id));
    }
  }
  for (const folder of plan.repoint) {
    await tx
      .update(draftTreeChanges)
      .set({ parentFolderId: twins.get(folder) as FolderId, updatedAt: now })
      .where(eq(draftTreeChanges.parentFolderId, folder));
  }
  return {
    twins,
    movedHidden: plan.boundaries.map(
      (boundary): NodeRef =>
        boundary.kind === "document"
          ? { kind: "document", id: boundary.id }
          : { kind: "folder", id: boundary.id },
    ),
  };
}

/**
 * Before a live delete of `root` (§8.3, B6): every hidden node sitting directly in a
 * visible folder of the subtree goes under a new hidden twin of that folder, at the same
 * path, with twins for every visible ancestor up to `root`. Nothing moved changes path in
 * any view, so no version moves.
 */
export async function splitHiddenContents(db: Database, root: FolderId): Promise<SplitResult> {
  const nodes = await loadSubtreeNodes(currentDrizzleDb(db), [root]);
  const visible = new Map<FolderId, SplitFolder>(
    nodes.flatMap((node) =>
      node.kind === "folder" && !node.hidden ? [[node.id as FolderId, node] as const] : [],
    ),
  );
  return applySplit(
    db,
    planSplit({
      folders: visible,
      boundaries: hiddenBoundaries(nodes, (folder) => visible.has(folder)),
      leaves: (folder) => visible.has(folder),
      splits: () => true,
    }),
  );
}

/** Hidden nodes whose parent is one of the given visible folders: a split's boundary. */
export function hiddenBoundaries(
  nodes: readonly SubtreeNode[],
  isSplitFolder: (folder: FolderId) => boolean,
): SplitBoundary[] {
  return nodes.flatMap((node): SplitBoundary[] =>
    node.hidden && node.parentId && isSplitFolder(node.parentId)
      ? [
          node.kind === "document"
            ? { kind: "document", id: node.id as DocumentId, parentId: node.parentId }
            : { kind: "folder", id: node.id as FolderId, parentId: node.parentId },
        ]
      : [],
  );
}
