/**
 * Live placement (contract §6.3, §7): the one owner of bringing nodes into the live tree.
 * `place` reveals a hidden node at its final location with its ancestors (a removed
 * document is never placed: nothing writes it back into being); `ensureLiveFolderPath` makes a live folder chain, revealing a hidden
 * folder at a path instead of making a twin. Both walk folders through `walkFolders`, the
 * walk branch and live creates share. Both are tree writes only: they return what they
 * placed, and their callers refresh the catalog.
 *
 * Every function runs in its caller's transaction, which holds the namespaces of every
 * source involved and the document locks of every target document.
 */
import type { ContextSourceId, FolderId, ThreadId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { testHook } from "../../../shared/test-hooks.js";
import { renderFilename } from "../context/paths.js";
import { absorbAt, absorbHiddenFolder } from "./folder-normalization.js";
import type { CreateFault } from "./hidden-node-types.js";
import { bumpLocationVersions, claimDocumentLocation } from "./node-locations.js";
import { insertFolder } from "./node-rows.js";
import { loadFolderChains } from "./tree-addresses.js";
import {
  createTreeReader,
  LIVE_TREE,
  type NodeRef,
  type PathResolution,
  type TreeReader,
  type TreeView,
} from "./tree-view.js";
import {
  findHiddenFolder,
  loadDocumentIdentityRows,
  loadFolderIdentityRows,
} from "./tree-view-sql.js";

/** Where a folder walk ended. */
export type FolderWalk =
  | { kind: "walked"; folderId: FolderId | null }
  /** `onGap` left a gap unfilled. */
  | { kind: "stopped" }
  /** A document, or two or more nodes, hold a segment in the view. */
  | { kind: "occupied"; occupant: Exclude<PathResolution<NodeRef>, { kind: "not_found" }> };

/**
 * The one folder walk, root to leaf in `view`: each segment's folder there, one lookup
 * per step, until the first segment the view shows nothing at. From that gap on, every
 * segment is a gap `onGap` fills (or leaves, with null): nothing below a gap is in the
 * view, since a hidden folder holds only hidden nodes (TM invariant 2) and a branch sees
 * every folder it placed something under.
 */
export async function walkFolders(
  db: Database,
  view: TreeView,
  contextSourceId: ContextSourceId,
  dir: readonly string[],
  onGap: (gap: { parentId: FolderId | null; name: string }) => Promise<FolderId | null>,
): Promise<FolderWalk> {
  const tree = createTreeReader(db);
  let parentId: FolderId | null = null;
  let gapped = false;
  for (const name of dir) {
    if (!gapped) {
      const found = await tree.childAt(view, {
        contextSourceId,
        parentId,
        filename: name,
        as: "folder",
      });
      if (found.kind === "found" && found.node.kind === "folder") {
        parentId = found.node.id;
        continue;
      }
      if (found.kind !== "not_found") return { kind: "occupied", occupant: found };
      gapped = true;
    }
    const filled = await onGap({ parentId, name });
    if (filled === null) return { kind: "stopped" };
    parentId = filled;
  }
  return { kind: "walked", folderId: parentId };
}

/**
 * Live folders root to leaf (§6.3 step 1; `mkdir` and the mover's folder ensure): a
 * visible folder is used; a hidden live folder at the path is revealed in place (its
 * ancestors are visible: the walk comes from the root); otherwise, after the live
 * opposite-kind check, a visible folder is inserted and its location claimed. The caller
 * holds the source's namespace lock. `placed`: the folders revealed or inserted.
 */
export type AssociatedRoot = { name: string; threadId: ThreadId };

/** Allocate or identify a proven root under its namespace; callers choose adoption. */
export async function allocateLiveAssociatedRoot(
  db: Database,
  contextSourceId: ContextSourceId,
  association: AssociatedRoot,
): Promise<{ id: FolderId; created: boolean }> {
  const [existing] = await currentDrizzleDb(db)
    .select({ id: folders.id, threadId: folders.threadId })
    .from(folders)
    .where(
      and(
        eq(folders.contextSourceId, contextSourceId),
        isNull(folders.parentId),
        eq(folders.name, association.name),
        isNull(folders.deletedAt),
        eq(folders.hidden, false),
      ),
    );
  if (existing) {
    if (existing.threadId !== association.threadId)
      throw new Error("Thread-root association mismatch");
    return { id: existing.id, created: false };
  }
  const id = await insertFolder(
    db,
    { contextSourceId, parentId: null, name: association.name },
    { hidden: false, threadId: association.threadId },
  );
  await claimDocumentLocation(db, contextSourceId, null, association.name);
  return { id, created: true };
}

export async function ensureLiveFolderPath(
  db: Database,
  input: {
    contextSourceId: ContextSourceId;
    dir: readonly string[];
    associatedRoot?: AssociatedRoot;
  },
): Promise<Result<{ folderId: FolderId | null; placed: readonly FolderId[] }, CreateFault>> {
  const { contextSourceId } = input;
  const created: FolderId[] = [];
  if (input.dir[0]?.startsWith("@")) {
    const association = input.associatedRoot;
    if (!association || association.name !== input.dir[0])
      throw new Error("Missing proven thread-root association");
    const root = await allocateLiveAssociatedRoot(db, contextSourceId, association);
    if (root.created) created.push(root.id);
  }
  const walk = await walkFolders(db, LIVE_TREE, contextSourceId, input.dir, async (gap) => {
    const at = { contextSourceId, ...gap };
    const hidden = await findHiddenFolder(db, at);
    const folderId = hidden ?? (await insertFolder(db, at, { hidden: false }));
    await claimDocumentLocation(db, contextSourceId, gap.parentId, gap.name);
    if (hidden) {
      await updatePlacedFolder(db, hidden, { parentId: gap.parentId, clear: "hidden" });
      // Another branch's hidden folder at the same path folds into the revealed one.
      await absorbAt(db, hidden);
    }
    created.push(folderId);
    return folderId;
  });
  if (walk.kind !== "walked") return Err({ code: "conflict" });
  return Ok({ folderId: walk.folderId, placed: created });
}

export type LiveLocation = {
  contextSourceId: ContextSourceId;
  parentFolderId: FolderId | null;
  name: string;
  /** Documents only. */
  extension?: string;
};

/** A hidden, living node to reveal at a live location. */
export type PlaceTarget = {
  node: NodeRef;
  at: LiveLocation;
};

/** What a placement did. */
export type PlaceResult = {
  /** Targets plus revealed or restored ancestors. */
  placed: readonly NodeRef[];
  /** The sources the catalog refresh covers, with `placed` as its invalidated roots. */
  sourceIds: readonly ContextSourceId[];
};

export type PlaceFault =
  | { code: "path_taken"; at: string; occupant: NodeRef }
  | { code: "stale"; node: NodeRef };

/**
 * One placement step (§7): each hidden target into the live tree at its final location, with its ancestors. Settles no links: its callers
 * do once the tree is final. The caller holds the namespaces of every source involved and
 * the document locks of every target document.
 */
export async function place(
  db: Database,
  input: { targets: readonly PlaceTarget[] },
): Promise<Result<PlaceResult, PlaceFault>> {
  const tree = createTreeReader(db);
  const placed: NodeRef[] = [];
  const sourceIds = new Set<ContextSourceId>();
  for (const target of input.targets) {
    const stale = await revalidatePlacement(db, target);
    if (stale) return Err(stale);
    await testHook("place.afterRevalidate");
    const ancestors = await placeAncestors(db, tree, target);
    if (!ancestors.ok) return ancestors;
    placed.push(...ancestors.value.placed);
    const { parentId } = ancestors.value;
    const filename =
      target.node.kind === "document"
        ? renderFilename(target.at.name, target.at.extension ?? "")
        : target.at.name;
    const taken = pathTaken(
      [...ancestors.value.path, filename].join("/"),
      await tree.childAt(LIVE_TREE, {
        contextSourceId: target.at.contextSourceId,
        parentId,
        filename,
        as: target.node.kind,
      }),
      target.node,
    );
    if (taken) return Err(taken);
    if (target.node.kind === "document") {
      await currentDrizzleDb(db)
        .update(documents)
        .set({
          contextSourceId: target.at.contextSourceId,
          folderId: parentId,
          name: target.at.name,
          extension: target.at.extension ?? "",
          hidden: false,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, target.node.id));
      await bumpLocationVersions(db, { documentIds: [target.node.id] });
    } else {
      await updatePlacedFolder(db, target.node.id, {
        parentId,
        clear: "hidden",
        contextSourceId: target.at.contextSourceId,
        name: target.at.name,
      });
    }
    await claimDocumentLocation(db, target.at.contextSourceId, parentId, filename);
    if (target.node.kind === "folder") await absorbAt(db, target.node.id);
    placed.push(target.node);
    sourceIds.add(target.at.contextSourceId);
  }
  return Ok({ placed, sourceIds: [...sourceIds] });
}

/** The fault for a live path something other than `self` holds, else null. */
function pathTaken(
  at: string,
  occupant: PathResolution<NodeRef>,
  self?: NodeRef,
): Extract<PlaceFault, { code: "path_taken" }> | null {
  if (occupant.kind === "not_found") return null;
  const other =
    occupant.kind === "found"
      ? occupant.node.id === self?.id
        ? undefined
        : occupant.node
      : occupant.nodes.find((node) => node.id !== self?.id);
  return other ? { code: "path_taken", at, occupant: other } : null;
}

async function revalidatePlacement(
  db: Database,
  target: PlaceTarget,
): Promise<{ code: "stale"; node: NodeRef } | null> {
  const [row] =
    target.node.kind === "document"
      ? await loadDocumentIdentityRows(currentDrizzleDb(db), [target.node.id])
      : await loadFolderIdentityRows(currentDrizzleDb(db), [target.node.id]);
  return row?.hidden && !row.deleted ? null : { code: "stale", node: target.node };
}

/**
 * The final location's folder chain, root down (TM invariant 2, decision 9): a visible
 * folder is kept; a hidden one is revealed, or, when a visible folder already holds its
 * path, absorbed into that one (§8.2); a soft-deleted one is restored and absorbs
 * any hidden twin a split left there, or the walk continues under the folder that now
 * holds its path, unless a document does.
 * Each placed folder takes the walk's current parent, so a repointed chain stays whole.
 */
async function placeAncestors(
  db: Database,
  tree: TreeReader,
  target: PlaceTarget,
): Promise<
  Result<
    {
      parentId: FolderId | null;
      path: string[];
      placed: NodeRef[];
    },
    PlaceFault
  >
> {
  const tx = currentDrizzleDb(db);
  const { contextSourceId, parentFolderId } = target.at;
  const chain =
    parentFolderId === null
      ? []
      : (await loadFolderChains(tx, [parentFolderId])).get(parentFolderId);
  if (!chain)
    return Err({ code: "stale", node: { kind: "folder", id: parentFolderId as FolderId } });
  const chainIds = chain.map((link) => link.id).reverse();
  const rows = new Map((await loadFolderIdentityRows(tx, chainIds)).map((row) => [row.id, row]));
  let parentId: FolderId | null = null;
  const path: string[] = [];
  const placed: NodeRef[] = [];
  for (const id of chainIds) {
    const row = rows.get(id);
    if (!row) return Err({ code: "stale", node: { kind: "folder", id } });
    path.push(row.name);
    if (!row.hidden && !row.deleted && row.parentId === parentId) {
      parentId = row.id;
      continue;
    }
    const holder = await tree.childAt(LIVE_TREE, {
      contextSourceId,
      parentId,
      filename: row.name,
      as: "folder",
    });
    if (holder.kind === "found" && holder.node.kind === "folder") {
      // One folder per path (decision 10): a hidden one folds into the visible holder; a
      // deleted one stays deleted and the walk continues under the holder.
      if (row.hidden && !row.deleted)
        await absorbHiddenFolder(db, { hidden: row.id, into: holder.node.id });
      parentId = holder.node.id;
      continue;
    }
    const taken = pathTaken(path.join("/"), holder);
    if (taken) return Err(taken);
    if (row.hidden && row.deleted) return Err({ code: "stale", node: { kind: "folder", id } });
    await updatePlacedFolder(db, row.id, {
      parentId,
      clear: row.hidden ? "hidden" : row.deleted ? "deleted" : null,
      contextSourceId,
    });
    await claimDocumentLocation(db, contextSourceId, parentId, row.name);
    // A split may have left a hidden twin at a restored folder's path (§8.3).
    if (row.deleted) await absorbAt(db, row.id);
    placed.push({ kind: "folder", id: row.id });
    parentId = row.id;
  }
  return Ok({ parentId, path, placed });
}

async function updatePlacedFolder(
  db: Database,
  folderId: FolderId,
  change: {
    parentId: FolderId | null;
    clear: "hidden" | "deleted" | null;
    contextSourceId?: ContextSourceId;
    name?: string;
  },
): Promise<void> {
  await currentDrizzleDb(db)
    .update(folders)
    .set({
      parentId: change.parentId,
      ...(change.contextSourceId ? { contextSourceId: change.contextSourceId } : {}),
      ...(change.name ? { name: change.name } : {}),
      ...(change.clear === "hidden" ? { hidden: false } : {}),
      ...(change.clear === "deleted" ? { deletedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folderId));
  await bumpLocationVersions(db, { folderIds: [folderId] });
}
