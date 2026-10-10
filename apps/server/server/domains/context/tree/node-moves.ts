/**
 * The batch move primitive (contract §8.5, N1, F19): one or many live nodes to final live
 * locations in four phases, so a single live move and Apply's relocation share one
 * implementation.
 *
 * Prepare builds one node-keyed relocation plan before any write: every node each
 * selected root carries (a selected descendant owns its own subtree and overrides the
 * destination its ancestor would give it), each node's original and final coordinates,
 * the split topology with original names, and the occupancy of the whole final namespace.
 * Vacate parks the selected roots under temporary names (partial unique indexes can't be
 * deferred, so a swap or renumber would otherwise collide); install writes the split from
 * the snapshot, ensures destination folders, sets final locations and absorbs; record
 * writes the whole set's history and bumps each moving node's version once. Every
 * temporary name is replaced in install; nothing reads one.
 *
 * Every phase runs in the caller's transaction, which holds the Work rows, the namespace
 * locks of every source involved (current and final) and the row locks §14 names.
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import {
  bumpLocationVersions,
  recordLocationHistory,
} from "../adapters/context-fs/document-locations.js";
import { renderFilename } from "../context/paths.js";
import {
  absorbAt,
  applySplit,
  hiddenBoundaries,
  planSplit,
  type SplitFolder,
  type SplitPlan,
} from "./folder-normalization.js";
import { ensureLiveFolderPath } from "./hidden-nodes.js";
import { treeHook } from "./test-hooks.js";
import { chainPrefix, loadFolderChains } from "./tree-addresses.js";
import { createTreeReader, LIVE_TREE, type NodeRef } from "./tree-view.js";
import {
  loadDocumentIdentityRows,
  loadFolderIdentityRows,
  loadSubtreeNodes,
  type SubtreeNode,
} from "./tree-view-sql.js";

/**
 * A final live location by path: destination folders may not exist yet, and install
 * ensures them through the live tree (revealing a hidden folder at a path, §6.3).
 */
export type MoveTarget = {
  contextSourceId: ContextSourceId;
  /** Folder names from the source root to the parent. */
  dir: readonly string[];
  name: string;
  /** Documents only. */
  extension?: string;
};

export type NodeMove = { node: NodeRef; to: MoveTarget };

export type PreparedMove = NodeMove & {
  /** The selected node's final source-relative path. */
  path: string;
  /** The document's file type after the move; null keeps it. */
  filetype: Filetype | null;
  /**
   * A folder leaving where drafts can hold it: another project (§8.3), or a Work-owned or
   * lineage Scratch source, which is never drafted. The hidden contents it owns split off
   * and stay.
   */
  splitsHidden: boolean;
};

/** One node of the plan, keyed by id: where it is, and where it will be. */
export type PlannedNode = {
  kind: "document" | "folder";
  id: string;
  hidden: boolean;
  /** The selected node whose move carries it (itself, for a selected node). */
  owner: string;
  from: { contextSourceId: ContextSourceId; path: string };
  /** Null: a hidden node split off by its owner's split; it stays, unversioned. */
  to: { contextSourceId: ContextSourceId; path: string } | null;
};

export type PreparedMoves = {
  moves: readonly PreparedMove[];
  nodes: ReadonlyMap<string, PlannedNode>;
  split: SplitPlan;
};

export type MoveFault = {
  code: "conflict" | "invalid_operation" | "stale_source";
  node?: NodeRef;
};

const TEMPORARY_PREFIX = "\u0001moving:";

function filenameOf(node: {
  kind: "document" | "folder";
  name: string;
  extension?: string | null;
}) {
  return node.kind === "document" ? renderFilename(node.name, node.extension ?? "") : node.name;
}

function slot(contextSourceId: string, path: string): string {
  return `${contextSourceId}\u0000${path}`;
}

/** Phase 1, no writes: the whole relocation plan, checked against the final namespace. */
export async function prepareMoves(
  db: Database,
  input: {
    moves: readonly NodeMove[];
    filetypeFor(move: NodeMove): Result<Filetype | null, MoveFault>;
  },
): Promise<Result<PreparedMoves, MoveFault>> {
  if (new Set(input.moves.map((move) => move.node.id)).size !== input.moves.length) {
    return Err({ code: "invalid_operation" });
  }
  const owners = await sourceOwners(
    db,
    input.moves.map((move) => move.to.contextSourceId),
  );

  // The selected roots as they are now.
  const moves: PreparedMove[] = [];
  const snapshot = new Map<string, SubtreeNode>();
  const paths = new Map<string, string>();
  for (const move of input.moves) {
    const current = await currentNode(db, move.node);
    if (!current) return Err({ code: "stale_source", node: move.node });
    const filetype = move.node.kind === "document" ? input.filetypeFor(move) : Ok(null);
    if (!filetype.ok) return filetype;
    const path = [...move.to.dir, filenameOf({ kind: move.node.kind, ...move.to })].join("/");
    if (
      move.node.kind === "folder" &&
      current.node.contextSourceId === move.to.contextSourceId &&
      (path === current.path || path.startsWith(`${current.path}/`))
    ) {
      return Err({ code: "invalid_operation", node: move.node });
    }
    const from = (await sourceOwners(db, [current.node.contextSourceId])).get(
      current.node.contextSourceId,
    );
    const to = owners.get(move.to.contextSourceId);
    const splitsHidden =
      move.node.kind === "folder" &&
      (from?.projectId !== to?.projectId || (to?.undrafted === true && !from?.undrafted));
    snapshot.set(current.node.id, current.node);
    paths.set(current.node.id, current.path);
    moves.push({ ...move, path, filetype: filetype.value, splitsHidden });
  }

  // Everything the selected folders carry, hidden included, before anything moves.
  for (const node of await loadSubtreeNodes(
    currentDrizzleDb(db),
    moves.flatMap((move) => (move.node.kind === "folder" ? [move.node.id as FolderId] : [])),
  )) {
    if (!snapshot.has(node.id)) snapshot.set(node.id, node);
  }
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const node = snapshot.get(id) as SubtreeNode;
    const path = `${pathOf(node.parentId as string)}/${filenameOf(node)}`;
    paths.set(id, path);
    return path;
  };

  // Ownership, once: the nearest selected node at or above each node.
  const selected = new Map(moves.map((move) => [move.node.id, move]));
  const ownerOf = (id: string): PreparedMove => {
    for (let at: string | null = id; at !== null; at = snapshot.get(at)?.parentId ?? null) {
      const move = selected.get(at);
      if (move) return move;
    }
    throw new Error(`Node ${id} has no selected owner`);
  };
  const nodes = new Map<string, PlannedNode>();
  for (const node of snapshot.values()) {
    const owner = ownerOf(node.id);
    const path = pathOf(node.id);
    const relative = path.slice(pathOf(owner.node.id).length);
    nodes.set(node.id, {
      kind: node.kind,
      id: node.id,
      hidden: node.hidden,
      owner: owner.node.id,
      from: { contextSourceId: node.contextSourceId, path },
      // Hidden contents never leave where their drafts hold them: they split off and stay.
      to:
        owner.splitsHidden && node.hidden
          ? null
          : { contextSourceId: owner.to.contextSourceId, path: owner.path + relative },
    });
  }

  const occupancy = await checkFinalNamespace(db, moves, nodes);
  if (!occupancy.ok) return occupancy;

  // The split, from the snapshot: original names and coordinates, never vacated ones.
  const plannedFolders = new Map<FolderId, SplitFolder>(
    [...snapshot.values()].flatMap((node) =>
      node.kind === "folder" ? [[node.id as FolderId, node] as const] : [],
    ),
  );
  const split = planSplit({
    folders: plannedFolders,
    boundaries: hiddenBoundaries(
      [...snapshot.values()].filter((node) => nodes.get(node.id)?.to === null),
      (folder) => nodes.get(folder)?.to != null && !nodes.get(folder)?.hidden,
    ),
    leaves: (folder) => nodes.get(folder)?.to != null,
    splits: (folder) => {
      const node = nodes.get(folder);
      return node !== undefined && (selected.get(node.owner)?.splitsHidden ?? false);
    },
  });
  return Ok({ moves, nodes, split });
}

/**
 * Same-kind, opposite-kind and document-as-ancestor occupancy over the whole final
 * namespace: the plan's own visible nodes against each other, then each selected root's
 * final path and its ancestors against live nodes outside the plan. A live node under a
 * planned root's final path is itself planned (its ancestor there moves), so carried
 * nodes meet live nodes only through their roots.
 */
async function checkFinalNamespace(
  db: Database,
  moves: readonly PreparedMove[],
  nodes: ReadonlyMap<string, PlannedNode>,
): Promise<Result<void, MoveFault>> {
  const planned = new Map<string, PlannedNode>();
  for (const node of nodes.values()) {
    if (node.hidden || node.to === null) continue;
    const key = slot(node.to.contextSourceId, node.to.path);
    if (planned.has(key)) return Err({ code: "conflict", node: refOf(node) });
    planned.set(key, node);
  }
  const tree = createTreeReader(db);
  for (const move of moves) {
    const segments = move.path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const path = segments.slice(0, length).join("/");
      const isFinal = length === segments.length;
      const mine = planned.get(slot(move.to.contextSourceId, path));
      if (!isFinal && mine?.kind === "document") return Err({ code: "conflict", node: move.node });
      const found = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: move.to.contextSourceId,
        path,
      });
      if (found.kind === "not_found") break;
      if (found.kind === "ambiguous") return Err({ code: "conflict", node: move.node });
      const occupant =
        found.node.kind === "document" ? found.node.document.id : found.node.folder.id;
      // A node of the plan leaves this path; nothing outside the plan sits under it.
      if (nodes.has(occupant)) break;
      if (isFinal || found.node.kind === "document") {
        return Err({ code: "conflict", node: move.node });
      }
    }
  }
  return Ok(undefined);
}

function refOf(node: PlannedNode): NodeRef {
  return node.kind === "document"
    ? { kind: "document", id: node.id as DocumentId }
    : { kind: "folder", id: node.id as FolderId };
}

/** Phase 2: every selected root to a temporary name in its parent, so no final path is held. */
export async function vacateMoves(db: Database, prepared: PreparedMoves): Promise<void> {
  const tx = currentDrizzleDb(db);
  for (const move of prepared.moves) {
    const name = `${TEMPORARY_PREFIX}${move.node.id}`;
    if (move.node.kind === "document") {
      await tx.update(documents).set({ name }).where(eq(documents.id, move.node.id));
    } else {
      await tx.update(folders).set({ name }).where(eq(folders.id, move.node.id));
    }
  }
}

/** Phase 3: the split from the snapshot, destination folders, final locations, absorb. */
export async function installMoves(
  db: Database,
  prepared: PreparedMoves,
): Promise<Result<void, MoveFault>> {
  await treeHook("moves.beforeInstall");
  const tx = currentDrizzleDb(db);
  if (prepared.split.boundaries.length > 0) await applySplit(db, prepared.split);
  // Folders before documents, shallow before deep: a later move may land inside an earlier one.
  const ordered = [...prepared.moves].sort(
    (a, b) =>
      Number(a.node.kind === "document") - Number(b.node.kind === "document") ||
      a.to.dir.length - b.to.dir.length,
  );
  for (const move of ordered) {
    const ensured = await ensureLiveFolderPath(db, {
      contextSourceId: move.to.contextSourceId,
      dir: move.to.dir,
    });
    if (!ensured.ok) return Err({ code: "conflict", node: move.node });
    const parentId = ensured.value;
    const now = new Date();
    if (move.node.kind === "document") {
      await tx
        .update(documents)
        .set({
          contextSourceId: move.to.contextSourceId,
          folderId: parentId,
          name: move.to.name,
          extension: move.to.extension ?? "",
          ...(move.filetype === null ? {} : { fileType: move.filetype }),
          updatedAt: now,
        })
        .where(eq(documents.id, move.node.id));
    } else {
      await tx
        .update(folders)
        .set({
          contextSourceId: move.to.contextSourceId,
          parentId,
          name: move.to.name,
          updatedAt: now,
        })
        .where(eq(folders.id, move.node.id));
      await carrySource(db, prepared, move);
    }
  }
  for (const move of prepared.moves) {
    if (move.node.kind === "folder") await absorbAt(db, move.node.id);
  }
  return Ok(undefined);
}

/**
 * The nodes a folder carries to another source take it (hidden ones included unless its
 * split left them behind), and, within the project, every change row located under it
 * takes the new source (TM "Folders").
 */
async function carrySource(db: Database, prepared: PreparedMoves, move: PreparedMove) {
  const target = move.to.contextSourceId;
  const carried = [...prepared.nodes.values()].filter(
    (node) =>
      node.owner === move.node.id &&
      node.to !== null &&
      node.id !== move.node.id &&
      node.from.contextSourceId !== target,
  );
  if (carried.length === 0) return;
  const tx = currentDrizzleDb(db);
  const ids = (kind: PlannedNode["kind"]) =>
    carried.filter((node) => node.kind === kind).map((node) => node.id);
  const folderIds = [move.node.id, ...ids("folder")] as FolderId[];
  const documentIds = ids("document") as DocumentId[];
  const now = new Date();
  for (let offset = 0; offset < folderIds.length; offset += 500) {
    const batch = folderIds.slice(offset, offset + 500);
    await tx
      .update(folders)
      .set({ contextSourceId: target, updatedAt: now })
      .where(inArray(folders.id, batch));
    if (!move.splitsHidden) {
      await tx.execute(sql`
        UPDATE draft_tree_changes SET context_source_id = ${target}::uuid, updated_at = NOW()
        WHERE parent_folder_id IN (${sql.join(
          batch.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    }
  }
  for (let offset = 0; offset < documentIds.length; offset += 500) {
    await tx
      .update(documents)
      .set({ contextSourceId: target, updatedAt: now })
      .where(inArray(documents.id, documentIds.slice(offset, offset + 500)));
  }
}

/**
 * Phase 4: the whole set's history (every visible vacated alias, then every visible final
 * claim), then one version bump per moving node. A node split off stays where it was, so
 * it takes neither.
 */
export async function recordMoves(db: Database, prepared: PreparedMoves): Promise<void> {
  const moving = [...prepared.nodes.values()].filter((node) => node.to !== null);
  const visible = moving.filter((node) => !node.hidden);
  await recordLocationHistory(db, {
    vacated: visible
      .filter((node) => node.kind === "document")
      .map((node) => ({ ...node.from, documentId: node.id })),
    claimed: visible.map((node) => node.to as NonNullable<PlannedNode["to"]>),
  });
  await bumpLocationVersions(db, {
    documentIds: moving.filter((node) => node.kind === "document").map((node) => node.id),
    folderIds: moving.filter((node) => node.kind === "folder").map((node) => node.id),
  });
}

/** The documents a prepared move actually relocates: what arrivals settle. */
export function movedDocumentIds(prepared: PreparedMoves): DocumentId[] {
  return [...prepared.nodes.values()]
    .filter((node) => node.kind === "document" && node.to !== null)
    .map((node) => node.id as DocumentId);
}

/** All four phases in order: a single live move. */
export async function moveNodes(
  db: Database,
  input: Parameters<typeof prepareMoves>[1],
): Promise<Result<PreparedMoves, MoveFault>> {
  const prepared = await prepareMoves(db, input);
  if (!prepared.ok) return prepared;
  await vacateMoves(db, prepared.value);
  const installed = await installMoves(db, prepared.value);
  if (!installed.ok) return installed;
  await recordMoves(db, prepared.value);
  return prepared;
}

/** A visible, live node as the snapshot records it, with its source-relative path. */
async function currentNode(
  db: Database,
  node: NodeRef,
): Promise<{ node: SubtreeNode; path: string } | null> {
  const tx = currentDrizzleDb(db);
  const row =
    node.kind === "document"
      ? (await loadDocumentIdentityRows(tx, [node.id as DocumentId]))[0]
      : (await loadFolderIdentityRows(tx, [node.id as FolderId]))[0];
  if (!row || row.hidden || row.deleted) return null;
  const parentId = "folderId" in row ? row.folderId : row.parentId;
  const extension = "extension" in row ? row.extension : null;
  const chains = await loadFolderChains(tx, [parentId]);
  return {
    node: {
      kind: node.kind,
      id: node.id,
      parentId,
      contextSourceId: row.contextSourceId,
      name: row.name,
      extension,
      hidden: false,
    },
    path:
      (parentId === null ? "" : chainPrefix(chains.get(parentId) ?? [])) +
      filenameOf({ kind: node.kind, name: row.name, extension }),
  };
}

async function sourceOwners(
  db: Database,
  sourceIds: readonly ContextSourceId[],
): Promise<ReadonlyMap<ContextSourceId, { projectId: string | null; undrafted: boolean }>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await currentDrizzleDb(db)
    .select({
      id: contextSources.id,
      projectId: sql<string | null>`coalesce(${contextSources.projectId}, ${works.projectId})`,
      workId: contextSources.workId,
      rootThreadId: contextSources.rootThreadId,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return new Map(
    rows.map((row) => [
      row.id,
      { projectId: row.projectId, undrafted: row.workId !== null || row.rootThreadId !== null },
    ]),
  );
}
