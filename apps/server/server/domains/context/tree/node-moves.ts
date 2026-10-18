/**
 * The live move kernel (contract §8.5, N1): one live node to a final live location.
 *
 * Preparing builds one node-keyed relocation plan before any write: every node the moved
 * node carries (hidden ones included), each node's original and final coordinates, the
 * split topology with original names, and the occupancy of the final path. Installing
 * writes the split from the snapshot, ensures destination folders, sets the final location
 * and absorbs; recording writes the carried set's history and bumps each moving node's
 * version once. Apply does not relocate: it reveals and restores documents where their
 * rows already are (`placement.ts`).
 *
 * Every step runs in the caller's transaction, which holds the Work rows, the namespace
 * locks of every source involved (current and final) and the row locks §14 names.
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { renderFilename } from "../context/paths.js";
import { branchReachKept, loadSourceOwners, type SourceOwner } from "./branch-ownership.js";
import {
  absorbAt,
  applySplit,
  hiddenBoundaries,
  planSplit,
  type SplitFolder,
  type SplitPlan,
} from "./folder-normalization.js";
import { bumpLocationVersions, recordLocationHistory } from "./node-locations.js";
import { ensureLiveFolderPath } from "./placement.js";
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

export type NodeMove = {
  node: NodeRef;
  to: MoveTarget;
  /** The document's file type after the move; null keeps it. */
  filetype: Filetype | null;
};

export type MoveFault = {
  code: "conflict" | "invalid_operation" | "stale_source";
  node?: NodeRef;
};

/** One node of the plan, keyed by id: where it is, and where it will be. */
type PlannedNode = {
  kind: "document" | "folder";
  id: string;
  hidden: boolean;
  from: { contextSourceId: ContextSourceId; path: string };
  /** Null: a hidden node split off by the move; it stays, unversioned. */
  to: { contextSourceId: ContextSourceId; path: string } | null;
};

type PreparedMove = {
  nodes: ReadonlyMap<string, PlannedNode>;
  split: SplitPlan;
};

function filenameOf(node: {
  kind: "document" | "folder";
  name: string;
  extension?: string | null;
}) {
  return node.kind === "document" ? renderFilename(node.name, node.extension ?? "") : node.name;
}

/**
 * Move one live node. Returns the documents that actually relocated (what arrivals
 * settle): a folder leaving where branches can hold it leaves its hidden contents behind.
 */
export async function moveNode(
  db: Database,
  move: NodeMove,
): Promise<Result<readonly DocumentId[], MoveFault>> {
  const prepared = await prepareMove(db, move);
  if (!prepared.ok) return prepared;
  const installed = await installMove(db, move, prepared.value);
  if (!installed.ok) return installed;
  const moving = [...prepared.value.nodes.values()].filter((node) => node.to !== null);
  await recordMove(db, moving);
  return Ok(moving.filter((node) => node.kind === "document").map((node) => node.id as DocumentId));
}

/** No writes: the whole relocation plan, checked against the final path. */
async function prepareMove(db: Database, move: NodeMove): Promise<Result<PreparedMove, MoveFault>> {
  const { node: ref, to } = move;
  const current = await currentNode(db, ref);
  if (!current) return Err({ code: "stale_source", node: ref });
  const path = [...to.dir, filenameOf({ kind: ref.kind, ...to })].join("/");
  if (
    ref.kind === "folder" &&
    current.node.contextSourceId === to.contextSourceId &&
    (path === current.path || path.startsWith(`${current.path}/`))
  ) {
    return Err({ code: "invalid_operation", node: ref });
  }
  const owners = await sourceOwners(db, [current.node.contextSourceId, to.contextSourceId]);
  const fromOwner = owners.get(current.node.contextSourceId);
  const toOwner = owners.get(to.contextSourceId);
  // A folder leaving where branches can hold it (to a source fewer branches may hold, §8.3, or to
  // a Work-owned or lineage Scratch source, which is never drafted) splits off the hidden
  // contents it owns, and they stay.
  const splitsHidden =
    ref.kind === "folder" &&
    (!fromOwner ||
      !toOwner ||
      !branchReachKept(fromOwner.owner, toOwner.owner) ||
      (toOwner.undrafted && !fromOwner.undrafted));

  // Everything the folder carries, hidden included, before anything moves.
  const snapshot = new Map<string, SubtreeNode>([[current.node.id, current.node]]);
  if (ref.kind === "folder") {
    for (const node of await loadSubtreeNodes(currentDrizzleDb(db), [ref.id as FolderId])) {
      if (!snapshot.has(node.id)) snapshot.set(node.id, node);
    }
  }
  const paths = new Map<string, string>([[current.node.id, current.path]]);
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const node = snapshot.get(id) as SubtreeNode;
    const found = `${pathOf(node.parentId as string)}/${filenameOf(node)}`;
    paths.set(id, found);
    return found;
  };
  const nodes = new Map<string, PlannedNode>();
  for (const node of snapshot.values()) {
    const from = pathOf(node.id);
    nodes.set(node.id, {
      kind: node.kind,
      id: node.id,
      hidden: node.hidden,
      from: { contextSourceId: node.contextSourceId, path: from },
      // Hidden contents never leave where their branches hold them: they split off and stay.
      to:
        splitsHidden && node.hidden
          ? null
          : {
              contextSourceId: to.contextSourceId,
              path: path + from.slice(current.path.length),
            },
    });
  }

  const free = await checkFinalPath(db, move, path, current.node.id);
  if (!free.ok) return free;

  // The split, from the snapshot: original names and coordinates.
  const split = planSplit({
    folders: new Map<FolderId, SplitFolder>(
      [...snapshot.values()].flatMap((node) =>
        node.kind === "folder" ? [[node.id as FolderId, node] as const] : [],
      ),
    ),
    boundaries: hiddenBoundaries(
      [...snapshot.values()].filter((node) => nodes.get(node.id)?.to === null),
      (folder) => nodes.get(folder)?.to != null && !nodes.get(folder)?.hidden,
    ),
    leaves: (folder) => nodes.get(folder)?.to != null,
  });
  return Ok({ nodes, split });
}

/**
 * The final path and each ancestor it needs against the live tree: a claim of the node's
 * kind at the end (a document and a folder meet through the shared namespace), a folder at
 * every prefix. The node itself, at its own path, is no conflict.
 */
async function checkFinalPath(
  db: Database,
  move: NodeMove,
  path: string,
  selfId: string,
): Promise<Result<void, MoveFault>> {
  const tree = createTreeReader(db);
  const segments = path.split("/");
  for (let length = 1; length <= segments.length; length += 1) {
    const isFinal = length === segments.length;
    const found = await tree.resolvePath(LIVE_TREE, {
      contextSourceId: move.to.contextSourceId,
      path: segments.slice(0, length).join("/"),
      as: isFinal ? move.node.kind : "folder",
    });
    if (found.kind === "not_found") break;
    if (found.kind === "ambiguous") return Err({ code: "conflict", node: move.node });
    const occupant = found.node.kind === "document" ? found.node.document.id : found.node.folder.id;
    if (occupant === selfId) break;
    if (isFinal || found.node.kind === "document") {
      return Err({ code: "conflict", node: move.node });
    }
  }
  return Ok(undefined);
}

/** The split from the snapshot, destination folders, the final location, absorb. */
async function installMove(
  db: Database,
  move: NodeMove,
  prepared: PreparedMove,
): Promise<Result<void, MoveFault>> {
  await treeHook("moves.beforeInstall");
  const tx = currentDrizzleDb(db);
  const { node, to } = move;
  if (prepared.split.boundaries.length > 0) await applySplit(db, prepared.split);
  const ensured = await ensureLiveFolderPath(db, {
    contextSourceId: to.contextSourceId,
    dir: to.dir,
  });
  if (!ensured.ok) return Err({ code: "conflict", node });
  // The mover's caller refreshes the catalog over every source the move touches.
  const parentId = ensured.value.folderId;
  const now = new Date();
  if (node.kind === "document") {
    await tx
      .update(documents)
      .set({
        contextSourceId: to.contextSourceId,
        folderId: parentId,
        name: to.name,
        extension: to.extension ?? "",
        ...(move.filetype === null ? {} : { fileType: move.filetype }),
        updatedAt: now,
      })
      .where(eq(documents.id, node.id));
    return Ok(undefined);
  }
  await tx
    .update(folders)
    .set({ contextSourceId: to.contextSourceId, parentId, name: to.name, updatedAt: now })
    .where(eq(folders.id, node.id));
  await carrySource(db, prepared, move);
  await absorbAt(db, node.id);
  return Ok(undefined);
}

/**
 * The nodes a folder carries to another source take it (hidden ones included unless its
 * split left them behind), and, within the project, every change row located under it
 * takes the new source (TM "Folders").
 */
async function carrySource(db: Database, prepared: PreparedMove, move: NodeMove) {
  const target = move.to.contextSourceId;
  const carried = [...prepared.nodes.values()].filter(
    (node) => node.to !== null && node.id !== move.node.id && node.from.contextSourceId !== target,
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
  }
  for (let offset = 0; offset < documentIds.length; offset += 500) {
    await tx
      .update(documents)
      .set({ contextSourceId: target, updatedAt: now })
      .where(inArray(documents.id, documentIds.slice(offset, offset + 500)));
  }
}

/**
 * History (every visible vacated alias, then every visible final claim), then one version
 * bump per moving node. A node split off stays where it was, so it takes neither.
 */
async function recordMove(db: Database, moving: readonly PlannedNode[]): Promise<void> {
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
): Promise<ReadonlyMap<ContextSourceId, { owner: SourceOwner; undrafted: boolean }>> {
  const owners = await loadSourceOwners(db, sourceIds);
  const rows = await currentDrizzleDb(db)
    .select({
      id: contextSources.id,
      workId: contextSources.workId,
      rootThreadId: contextSources.rootThreadId,
      chatThreadId: contextSources.chatThreadId,
    })
    .from(contextSources)
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  const out = new Map<ContextSourceId, { owner: SourceOwner; undrafted: boolean }>();
  for (const row of rows) {
    const owner = owners.get(row.id);
    if (owner)
      out.set(row.id, {
        owner,
        undrafted: row.workId !== null || row.rootThreadId !== null || row.chatThreadId !== null,
      });
  }
  return out;
}
