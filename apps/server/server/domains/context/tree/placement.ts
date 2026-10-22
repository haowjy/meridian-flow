/**
 * Live placement (contract §6.3, §7): the one owner of bringing nodes into the live tree.
 * `placeLive` brings one node to a live location with its ancestors under the one
 * name-claim rule; `placeLiveCycle` installs a cycle before normalizing any member.
 * `place` reveals hidden nodes through `placeLive`, and the removal record's owner
 * restores a deleted document through it (`restoreDocument`: no write brings a removed
 * document back as a side effect). `ensureLiveFolderPath` makes a live folder chain, revealing a hidden
 * folder at a path instead of making a twin. Both walk folders through `walkFolders`, the
 * walk branch and live creates share. Both are tree writes only: they return what they
 * placed, and their callers refresh the catalog.
 *
 * Every function runs in its caller's transaction, which holds the namespaces of every
 * source involved and the document locks of every target document.
 */
import type { ContextSourceId, FolderId } from "@meridian/contracts";
import { allocateFilename, folderDocumentName } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { testHook } from "../../../shared/test-hooks.js";
import { absorbAt, absorbHiddenFolder } from "./folder-normalization.js";
import type { CreateFault } from "./hidden-node-types.js";
import { normalizeNames } from "./name-normalization.js";
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
export async function ensureLiveFolderPath(
  db: Database,
  input: { contextSourceId: ContextSourceId; dir: readonly string[] },
): Promise<Result<{ folderId: FolderId | null; placed: readonly FolderId[] }, CreateFault>> {
  const { contextSourceId } = input;
  const created: FolderId[] = [];
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
    await normalizeNames(db, [{ kind: "folder", id: folderId }]);
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
  /** Actual free locations each target claimed, in target order. */
  landed: readonly PlaceTarget[];
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
  const placed: NodeRef[] = [];
  const sourceIds = new Set<ContextSourceId>();
  const landedTargets: PlaceTarget[] = [];
  for (const target of input.targets) {
    const stale = await revalidatePlacement(db, target);
    if (stale) return Err(stale);
    await testHook("place.afterRevalidate");
    const landed = await placeLive(db, target, (parentId, at) =>
      reveal(db, { ...target, at }, parentId),
    );
    if (!landed.ok) return landed;
    if (target.node.kind === "folder") await absorbAt(db, target.node.id);
    placed.push(...landed.value.ancestors, target.node);
    sourceIds.add(target.at.contextSourceId);
    landedTargets.push({ ...target, at: landed.value.at });
  }
  return Ok({ placed, sourceIds: [...sourceIds], landed: landedTargets });
}

/**
 * One node into the live tree at `target.at`, whatever its lifecycle: its folder chain
 * placed root down (`placeAncestors`), the one name-claim rule at its final path, then
 * `land` writes the node's row under the parent the walk resolved (which may differ from
 * `target.at.parentFolderId` when another folder now holds a deleted one's path), and the
 * path's previous-location aliases are consumed. Reveal (`place`) and restore
 * (`restoreDocument`) differ only in what they validate first and what `land` writes. A
 * fault may leave ancestors placed: the caller rolls back.
 */
export async function placeLive(
  db: Database,
  target: PlaceTarget,
  land: (parentId: FolderId | null, at: LiveLocation) => Promise<void>,
): Promise<Result<{ ancestors: readonly NodeRef[]; at: LiveLocation }, PlaceFault>> {
  const prepared = await prepareLivePlacement(db, target);
  if (!prepared.ok) return prepared;
  const { ancestors, parentId, at, filename } = prepared.value;
  await land(parentId, at);
  await normalizeNames(db, [target.node]);
  await claimDocumentLocation(db, target.at.contextSourceId, parentId, filename);
  return Ok({ ancestors, at });
}

/** Place a cycle without normalizing an intermediate overlap between its hidden members. */
export async function placeLiveCycle(
  db: Database,
  targets: readonly PlaceTarget[],
  land: (target: PlaceTarget, parentId: FolderId | null, at: LiveLocation) => Promise<void>,
): Promise<Result<readonly LiveLocation[], PlaceFault>> {
  const placed: {
    target: PlaceTarget;
    parentId: FolderId | null;
    at: LiveLocation;
    filename: string;
  }[] = [];
  for (const target of targets) {
    const prepared = await prepareLivePlacement(db, target);
    if (!prepared.ok) return prepared;
    const { parentId, at, filename } = prepared.value;
    await land(target, parentId, at);
    placed.push({ target, parentId, at, filename });
  }
  await normalizeNames(
    db,
    placed.map(({ target }) => target.node),
  );
  for (const { target, parentId, filename } of placed)
    await claimDocumentLocation(db, target.at.contextSourceId, parentId, filename);
  return Ok(placed.map(({ at }) => at));
}

async function prepareLivePlacement(
  db: Database,
  target: PlaceTarget,
): Promise<
  Result<
    {
      ancestors: readonly NodeRef[];
      parentId: FolderId | null;
      at: LiveLocation;
      filename: string;
    },
    PlaceFault
  >
> {
  const tree = createTreeReader(db);
  const ancestors = await placeAncestors(db, tree, target);
  if (!ancestors.ok) return ancestors;
  const { parentId } = ancestors.value;
  const desired =
    target.node.kind === "document"
      ? ({
          kind: "document",
          name: target.at.name,
          extension: target.at.extension ?? "",
        } as const)
      : ({ kind: "folder", name: target.at.name } as const);
  const filename = await allocateFilename(desired, async ({ filename }) =>
    Boolean(
      pathTaken(
        [...ancestors.value.path, filename].join("/"),
        await tree.childAt(LIVE_TREE, {
          contextSourceId: target.at.contextSourceId,
          parentId,
          filename,
          as: target.node.kind,
        }),
        target.node,
      ),
    ),
  );
  const extension = target.node.kind === "document" ? (target.at.extension ?? "") : undefined;
  const at: LiveLocation = {
    ...target.at,
    parentFolderId: parentId,
    name: extension ? filename.slice(0, -(extension.length + 1)) : filename,
  };
  return Ok({ ancestors: ancestors.value.placed, parentId, at, filename });
}

/** A hidden target's row at its final location, visible. */
async function reveal(db: Database, target: PlaceTarget, parentId: FolderId | null) {
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
    await normalizeNames(db, [{ kind: "folder", id: row.id }]);
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
      ...(change.name ? { name: change.name, documentAlias: folderDocumentName(change.name) } : {}),
      ...(change.clear === "hidden" ? { hidden: false } : {}),
      ...(change.clear === "deleted" ? { deletedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folderId));
  await bumpLocationVersions(db, { folderIds: [folderId] });
}
