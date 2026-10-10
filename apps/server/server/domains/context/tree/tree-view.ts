/**
 * The tree view: which documents and folders a reader sees, live or in one draft
 * (target model "Readers"). A hidden node is in no live view; in a draft that created
 * it, it is an ordinary node at the draft's location. Readers select from
 * `visibleDocuments(view)` / `visibleFolders(view)` or ask the `TreeReader`; neither
 * they nor anything outside this module reads the hidden column.
 */
import type {
  ContextSourceId,
  DocumentId,
  DraftId,
  FolderId,
  ProjectId,
  WorkId,
} from "@meridian/contracts";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { type AnyColumn, and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { isStorageBackedDocument } from "../adapters/catalog-file-mapper.js";
import { renderFilename } from "../context/paths.js";
import {
  chainPrefix,
  type DocumentCoordinates,
  type FolderLink,
  loadFolderChains,
  type NodeAddress,
  type NodeLocation,
  presentSourceId,
  projectOfDocument,
  spellNodeAddresses,
} from "./tree-addresses.js";
import {
  type DocumentIdentityRow,
  type DraftLocation,
  loadActiveDraftUses,
  loadDocumentIdentityRows,
  loadDraftCreatedDocuments,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
  visibleFoldersSql,
} from "./tree-view-sql.js";

export type { DocumentCoordinates, NodeAddress } from "./tree-addresses.js";
export {
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
  visibleFoldersSql,
} from "./tree-view-sql.js";

export type TreeView = { kind: "live" } | { kind: "draft"; draftId: DraftId };
export const LIVE_TREE: TreeView = Object.freeze({ kind: "live" });

export type NodeRef = { kind: "document"; id: DocumentId } | { kind: "folder"; id: FolderId };

export type VisibleDocument = {
  id: DocumentId;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  name: string;
  extension: string;
  fileType: string;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  metadata: JsonObject;
  provisionalName: boolean;
  locationVersion: bigint;
  hidden: boolean;
  updatedAt: Date;
  /** Source-relative path in this view, with extension. */
  path: string;
};

export type VisibleFolder = {
  id: FolderId;
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
  hidden: boolean;
  locationVersion: bigint;
  path: string;
};

export type PathResolution<N> =
  | { kind: "found"; node: N }
  /** Two or more visible nodes at one path in this view. */
  | { kind: "ambiguous"; ids: readonly [string, string, ...string[]] }
  | { kind: "not_found" };

export type TreeNode =
  | { kind: "document"; document: VisibleDocument }
  | { kind: "folder"; folder: VisibleFolder };

export type DraftUse = { draftId: DraftId; originWorkId: WorkId | null; createdAt: Date };

export type IdentityStatus =
  /** Visible in this view, at `address` in this view. */
  | { kind: "visible"; address: NodeAddress; hidden: boolean }
  /**
   * Hidden and not used by this view's draft. `draft` is the reader's own if it uses it,
   * otherwise the oldest active draft that uses it; `address` is where that draft has it.
   * No content access, no path occupancy.
   */
  | {
      kind: "hidden";
      documentId: DocumentId;
      draft: DraftUse;
      usedBy: readonly DraftUse[];
      address: NodeAddress;
    }
  /** Soft-deleted while visible; the last address it held (decision 15). */
  | { kind: "deleted"; documentId: DocumentId; lastAddress: NodeAddress | null }
  /** A tombstone, a hidden node no draft uses, a missing id, or an address that can't be spelled. */
  | { kind: "gone"; documentId: DocumentId };

export type TreeStateNode = {
  nodeKind: "document";
  nodeId: DocumentId;
  /** created: the draft has a `created` row. edited: the caller names it (text only). */
  origin: "created" | "edited";
  /** Created and still hidden: "new". */
  hidden: boolean;
  binary: boolean;
  fileType: string;
  live: {
    contextSourceId: ContextSourceId;
    folderId: FolderId | null;
    path: string;
    deleted: boolean;
    /** Soft-deleted ancestor folders, nearest first: restored with it (decision 9). */
    deletedAncestors: readonly FolderId[];
  };
  /** Where Apply places it: the draft's location for a created item, else its row's. */
  target: {
    contextSourceId: ContextSourceId;
    parentFolderId: FolderId | null;
    name: string;
    extension: string;
    path: string;
  };
  /** The rendered location token's source. */
  locationVersion: bigint;
  conflict:
    | { kind: "none" }
    /**
     * 5a (F11): a different node visible in the draft holds the target path, or a
     * document holds the path of a folder the target needs.
     */
    | { kind: "clash"; withNode: NodeRef; at: string }
    /** Created, revealed, then moved or renamed live: Apply names it back. */
    | { kind: "relocated" }
    /** Created-and-revealed or edited, then deleted live: Apply restores it (decision 7, F9). */
    | { kind: "deleted_live" };
};

export type DocumentLineage = {
  status: "visible" | "deleted";
  contextSourceId: ContextSourceId;
  /** The document's folder and its ancestors, nearest first. */
  folders: readonly { id: FolderId; deleted: boolean }[];
};

export interface TreeReader {
  resolvePath(
    view: TreeView,
    at: { contextSourceId: ContextSourceId; path: string },
  ): Promise<PathResolution<TreeNode>>;
  /** An id names one node; other visible ids at its address in this view are `clashesWith`. */
  findById(
    view: TreeView,
    id: DocumentId,
  ): Promise<
    | { kind: "found"; document: VisibleDocument; clashesWith: readonly DocumentId[] }
    | { kind: "not_found" }
  >;
  findFolderById(view: TreeView, id: FolderId): Promise<VisibleFolder | null>;
  identityStatus(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, IdentityStatus>>;
  /** Exact canonical addresses → documents visible there in this view, by `coordinatesKey`. */
  occupantsAt(
    view: TreeView,
    addresses: readonly DocumentCoordinates[],
  ): Promise<ReadonlyMap<string, DocumentId[]>>;
  /**
   * The draft's created documents, plus the edited documents the caller names (the
   * draft's branches with rows; the tree view doesn't read branches).
   */
  treeState(draftId: DraftId, edited?: readonly DocumentId[]): Promise<TreeStateNode[]>;
  /** File facts: in this view, its folder chain; deleted, its last chain; else null. */
  lineage(view: TreeView, id: DocumentId): Promise<DocumentLineage | null>;
  projectOfDocument(id: DocumentId): Promise<ProjectId | null>;
}

/** The key `occupantsAt` answers under. */
export function coordinatesKey(
  at: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "path">,
): string {
  return JSON.stringify([at.projectId, at.scheme, at.workId, at.path]);
}

type VisibleDocumentRow = Omit<VisibleDocument, "path"> & {
  createdAt: Date;
  draftLocated: boolean;
};
type VisibleFolderRow = {
  id: FolderId;
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
  hidden: boolean;
  locationVersion: bigint;
};

/** Every (name, extension) pair that renders as `filename`: lookups stay exact and indexed. */
function filenameSplits(filename: string): { name: string; extension: string }[] {
  const splits = [{ name: filename, extension: "" }];
  for (let at = 1; at < filename.length - 1; at += 1) {
    if (filename[at] === ".") {
      splits.push({ name: filename.slice(0, at), extension: filename.slice(at + 1) });
    }
  }
  return splits;
}

function folderPath(chain: readonly FolderLink[] | undefined, filename: string): string {
  return chainPrefix(chain ?? []) + filename;
}

export function createTreeReader(db: Database): TreeReader {
  const tx = (): DrizzleDb => currentDrizzleDb(db);

  function under(column: AnyColumn, parents: readonly (FolderId | null)[]): SQL {
    const ids = parents.filter((parent): parent is FolderId => parent !== null);
    const conditions = [
      ...(parents.includes(null) ? [isNull(column)] : []),
      ...(ids.length > 0 ? [inArray(column, ids)] : []),
    ];
    return (conditions.length === 1 ? conditions[0] : or(...conditions)) ?? sql`false`;
  }

  async function documentRows(
    view: TreeView,
    where: (vd: VisibleDocumentsSubquery) => SQL | undefined,
  ) {
    const vd = visibleDocuments(view);
    const rows: VisibleDocumentRow[] = await tx().select().from(vd).where(where(vd));
    return rows;
  }

  async function folderRows(
    view: TreeView,
    where: (vf: VisibleFoldersSubquery) => SQL | undefined,
  ) {
    const vf = visibleFolders(view);
    const rows: VisibleFolderRow[] = await tx()
      .select({
        id: vf.id,
        contextSourceId: vf.contextSourceId,
        parentId: vf.parentId,
        name: vf.name,
        hidden: vf.hidden,
        locationVersion: vf.locationVersion,
      })
      .from(vf)
      .where(where(vf));
    return rows;
  }

  function toDocument(row: VisibleDocumentRow, path: string): VisibleDocument {
    return {
      id: row.id,
      contextSourceId: row.contextSourceId,
      folderId: row.folderId,
      name: row.name,
      extension: row.extension,
      fileType: row.fileType,
      storageUrl: row.storageUrl,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      metadata: row.metadata,
      provisionalName: row.provisionalName,
      locationVersion: row.locationVersion,
      hidden: row.hidden,
      updatedAt: row.updatedAt,
      path,
    };
  }

  /** Every visible node at a source-relative path in this view. */
  async function nodesAt(
    view: TreeView,
    contextSourceId: ContextSourceId,
    path: string,
  ): Promise<{ documents: VisibleDocumentRow[]; folders: VisibleFolderRow[]; path: string }> {
    const segments = path.split("/").filter(Boolean);
    const normalized = segments.join("/");
    const filename = segments.pop();
    if (filename === undefined || !isUuid(contextSourceId)) {
      return { documents: [], folders: [], path: normalized };
    }
    // A path can pass through more than one visible folder of one name only when a live
    // absorb brought hidden twins together; follow every one.
    let parents: (FolderId | null)[] = [null];
    for (const name of segments) {
      const rows = await folderRows(view, (vf) =>
        and(
          eq(vf.contextSourceId, contextSourceId),
          under(vf.parentId, parents),
          eq(vf.name, name),
        ),
      );
      parents = rows.map((row) => row.id);
      if (parents.length === 0) return { documents: [], folders: [], path: normalized };
    }
    const documents = await documentRows(view, (vd) =>
      and(
        eq(vd.contextSourceId, contextSourceId),
        under(vd.folderId, parents),
        or(
          ...filenameSplits(filename).map((split) =>
            and(eq(vd.name, split.name), eq(vd.extension, split.extension)),
          ),
        ),
      ),
    );
    const folders = await folderRows(view, (vf) =>
      and(
        eq(vf.contextSourceId, contextSourceId),
        under(vf.parentId, parents),
        eq(vf.name, filename),
      ),
    );
    return { documents, folders, path: normalized };
  }

  /** Visible documents at each position in this view, by the position's key. */
  async function documentsAtPositions(
    view: TreeView,
    positions: readonly Position[],
  ): Promise<{ key: number; id: DocumentId }[]> {
    if (positions.length === 0) return [];
    const rows = await tx().execute<{ key: number; id: string }>(sql`
      SELECT p.key, vd.id::text AS id
      FROM (VALUES ${positionValues(positions)}) AS p(key, source_id, folder_id, filename)
      JOIN ${visibleDocumentsSql(view)} vd ON vd.context_source_id = p.source_id
        AND (vd.folder_id = p.folder_id OR (vd.folder_id IS NULL AND p.folder_id IS NULL))
        AND vd.name || CASE WHEN vd.extension = '' THEN '' ELSE '.' || vd.extension END
          = p.filename`);
    return rows.map((row) => ({ key: Number(row.key), id: row.id as DocumentId }));
  }

  async function foldersAtPositions(
    view: TreeView,
    positions: readonly Position[],
  ): Promise<{ key: number; id: FolderId }[]> {
    if (positions.length === 0) return [];
    const rows = await tx().execute<{ key: number; id: string }>(sql`
      SELECT p.key, vf.id::text AS id
      FROM (VALUES ${positionValues(positions)}) AS p(key, source_id, folder_id, filename)
      JOIN ${visibleFoldersSql(view)} vf ON vf.context_source_id = p.source_id
        AND (vf.parent_id = p.folder_id OR (vf.parent_id IS NULL AND p.folder_id IS NULL))
        AND vf.name = p.filename`);
    return rows.map((row) => ({ key: Number(row.key), id: row.id as FolderId }));
  }

  async function resolvePath(
    view: TreeView,
    at: { contextSourceId: ContextSourceId; path: string },
  ): Promise<PathResolution<TreeNode>> {
    const found = await nodesAt(view, at.contextSourceId, at.path);
    const nodes: TreeNode[] = [
      ...found.documents.map((row) => ({
        kind: "document" as const,
        document: toDocument(row, found.path),
      })),
      ...found.folders.map((row) => ({
        kind: "folder" as const,
        folder: { ...row, path: found.path },
      })),
    ];
    const [first, second, ...rest] = nodes;
    if (!first) return { kind: "not_found" };
    if (!second) return { kind: "found", node: first };
    return { kind: "ambiguous", ids: [nodeId(first), nodeId(second), ...rest.map(nodeId)] };
  }

  async function findById(view: TreeView, id: DocumentId) {
    if (!isUuid(id)) return { kind: "not_found" } as const;
    const [row] = await documentRows(view, (vd) => eq(vd.id, id));
    if (!row) return { kind: "not_found" } as const;
    const chains = await loadFolderChains(tx(), [row.folderId]);
    const path = folderPath(
      row.folderId === null ? [] : chains.get(row.folderId),
      renderFilename(row.name, row.extension),
    );
    const clashes = await documentRows(view, (vd) =>
      and(
        eq(vd.contextSourceId, row.contextSourceId),
        under(vd.folderId, [row.folderId]),
        eq(vd.name, row.name),
        eq(vd.extension, row.extension),
        ne(vd.id, id),
      ),
    );
    return {
      kind: "found",
      document: toDocument(row, path),
      clashesWith: clashes.map((clash) => clash.id),
    } as const;
  }

  async function findFolderById(view: TreeView, id: FolderId): Promise<VisibleFolder | null> {
    if (!isUuid(id)) return null;
    const [row] = await folderRows(view, (vf) => eq(vf.id, id));
    if (!row) return null;
    const chains = await loadFolderChains(tx(), [row.id]);
    const chain = chains.get(row.id) ?? [];
    return { ...row, path: chainPrefix(chain).slice(0, -1) };
  }

  async function identityStatus(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, IdentityStatus>> {
    const unique = [...new Set(ids)];
    const known = unique.filter(isUuid);
    const rows = new Map((await loadDocumentIdentityRows(tx(), known)).map((row) => [row.id, row]));
    const visible = new Map(
      (known.length === 0 ? [] : await documentRows(view, (vd) => inArray(vd.id, known))).map(
        (row) => [row.id, row],
      ),
    );
    const hiddenIds = [...rows.values()]
      .filter((row) => row.hidden && !row.deleted && !visible.has(row.id))
      .map((row) => row.id);
    const uses = new Map<DocumentId, ReturnType<typeof draftUse>[]>();
    for (const use of await loadActiveDraftUses(tx(), hiddenIds)) {
      uses.set(use.documentId, [...(uses.get(use.documentId) ?? []), draftUse(use)]);
    }

    // Decide first, then spell every chosen location in one batch.
    type Pending =
      | { kind: "visible"; location: NodeLocation; hidden: boolean }
      | { kind: "hidden"; location: NodeLocation; draft: DraftUse; usedBy: DraftUse[] }
      | { kind: "deleted"; location: NodeLocation }
      | { kind: "gone" };
    const decided = new Map<DocumentId, Pending>();
    for (const id of unique) {
      const row = rows.get(id);
      const shown = visible.get(id);
      if (!row || (row.hidden && row.deleted)) {
        decided.set(id, { kind: "gone" });
      } else if (shown) {
        decided.set(id, { kind: "visible", location: rowLocation(shown), hidden: row.hidden });
      } else if (row.hidden) {
        const usedBy = uses.get(id) ?? [];
        const chosen =
          (view.kind === "draft" && usedBy.find((use) => use.use.draftId === view.draftId)) ||
          usedBy[0];
        decided.set(
          id,
          chosen
            ? {
                kind: "hidden",
                location: draftedLocation(row, chosen.location),
                draft: chosen.use,
                usedBy: usedBy.map((use) => use.use),
              }
            : { kind: "gone" },
        );
      } else if (row.deleted) {
        decided.set(id, { kind: "deleted", location: rowLocation(row) });
      } else {
        decided.set(id, { kind: "gone" });
      }
    }
    const spellable = [...decided.entries()].flatMap(([id, pending]) =>
      pending.kind === "gone" ? [] : [{ id, location: pending.location }],
    );
    const addresses = await spellNodeAddresses(
      tx(),
      spellable.map((each) => each.location),
    );
    const addressOf = new Map(spellable.map((each, index) => [each.id, addresses[index] ?? null]));

    const out = new Map<DocumentId, IdentityStatus>();
    for (const [id, pending] of decided) {
      const address = addressOf.get(id) ?? null;
      if (pending.kind === "deleted") {
        out.set(id, { kind: "deleted", documentId: id, lastAddress: address });
      } else if (pending.kind === "gone" || !address) {
        out.set(id, { kind: "gone", documentId: id });
      } else if (pending.kind === "visible") {
        out.set(id, { kind: "visible", address, hidden: pending.hidden });
      } else {
        out.set(id, {
          kind: "hidden",
          documentId: id,
          draft: pending.draft,
          usedBy: pending.usedBy,
          address,
        });
      }
    }
    return out;
  }

  async function occupantsAt(
    view: TreeView,
    addresses: readonly DocumentCoordinates[],
  ): Promise<ReadonlyMap<string, DocumentId[]>> {
    const out = new Map<string, DocumentId[]>();
    for (const at of addresses) {
      const key = coordinatesKey(at);
      if (out.has(key)) continue;
      const sourceId = await presentSourceId(tx(), {
        scheme: at.scheme,
        workId: at.workId,
        project: { id: at.projectId },
      });
      const found = sourceId ? await nodesAt(view, sourceId, at.path) : null;
      out.set(
        key,
        found && found.path === at.path ? found.documents.map((document) => document.id) : [],
      );
    }
    return out;
  }

  async function treeState(
    draftId: DraftId,
    edited: readonly DocumentId[] = [],
  ): Promise<TreeStateNode[]> {
    const view: TreeView = { kind: "draft", draftId };
    const created = isUuid(draftId) ? await loadDraftCreatedDocuments(tx(), draftId) : [];
    const createdIds = new Set(created.map((each) => each.row.id));
    const editedRows = await loadDocumentIdentityRows(
      tx(),
      [...new Set(edited)].filter((id) => isUuid(id) && !createdIds.has(id)),
    );
    const items: {
      origin: "created" | "edited";
      row: DocumentIdentityRow;
      draft: DraftLocation | null;
    }[] = [
      // A tombstone is no longer the draft's: repair-on-touch drops its row (§12.4).
      ...created
        .filter((each) => !(each.row.hidden && each.row.deleted))
        .map((each) => ({
          origin: "created" as const,
          row: each.row,
          draft: each.draft.contextSourceId === null ? null : each.draft,
        })),
      // A hidden document the draft didn't create isn't in the draft's view.
      ...editedRows
        .filter((row) => !row.hidden)
        .map((row) => ({ origin: "edited" as const, row, draft: null })),
    ];
    const targets = items.map(({ row, draft }) => ({
      contextSourceId: (draft?.contextSourceId ?? row.contextSourceId) as ContextSourceId,
      parentFolderId: draft ? draft.parentFolderId : row.folderId,
      name: draft?.name ?? row.name,
      extension: draft?.extension ?? row.extension,
    }));
    const chains = await loadFolderChains(tx(), [
      ...items.map(({ row }) => row.folderId),
      ...targets.map((target) => target.parentFolderId),
    ]);
    const chainOf = (folderId: FolderId | null) =>
      folderId === null ? [] : (chains.get(folderId) ?? []);

    // Every path a target needs: its own, then each folder of its chain, nearest first.
    const positions: (Position & { item: number; at: string; target: boolean })[] = [];
    targets.forEach((target, item) => {
      const chain = chainOf(target.parentFolderId);
      const filename = renderFilename(target.name, target.extension);
      positions.push({
        key: positions.length,
        item,
        target: true,
        contextSourceId: target.contextSourceId,
        folderId: target.parentFolderId,
        filename,
        at: folderPath(chain, filename),
      });
      chain.forEach((folder, depth) => {
        positions.push({
          key: positions.length,
          item,
          target: false,
          contextSourceId: target.contextSourceId,
          folderId: folder.parentId,
          filename: folder.name,
          at: chainPrefix(chain.slice(depth)).slice(0, -1),
        });
      });
    });
    const documentHits = await documentsAtPositions(view, positions);
    const folderHits = await foldersAtPositions(
      view,
      positions.filter((position) => position.target),
    );
    const clashOf = (item: number): { withNode: NodeRef; at: string } | null => {
      const nodeId = items[item]?.row.id;
      for (const position of positions.filter((each) => each.item === item)) {
        const document = documentHits.find((hit) => hit.key === position.key && hit.id !== nodeId);
        if (document) return { withNode: { kind: "document", id: document.id }, at: position.at };
        const folder = position.target && folderHits.find((hit) => hit.key === position.key);
        if (folder) return { withNode: { kind: "folder", id: folder.id }, at: position.at };
      }
      return null;
    };

    return items.map(({ origin, row, draft }, item): TreeStateNode => {
      const target = targets[item] as (typeof targets)[number];
      const liveChain = chainOf(row.folderId);
      const clash = clashOf(item);
      const relocated =
        origin === "created" &&
        !row.hidden &&
        draft !== null &&
        (draft.contextSourceId !== row.contextSourceId ||
          draft.parentFolderId !== row.folderId ||
          draft.name !== row.name ||
          draft.extension !== row.extension);
      return {
        nodeKind: "document",
        nodeId: row.id,
        origin,
        hidden: row.hidden,
        binary: isStorageBackedDocument(row),
        fileType: row.fileType,
        live: {
          contextSourceId: row.contextSourceId,
          folderId: row.folderId,
          path: folderPath(liveChain, renderFilename(row.name, row.extension)),
          deleted: row.deleted,
          deletedAncestors: liveChain.filter((folder) => folder.deleted).map((folder) => folder.id),
        },
        target: {
          ...target,
          path: folderPath(
            chainOf(target.parentFolderId),
            renderFilename(target.name, target.extension),
          ),
        },
        locationVersion: row.locationVersion,
        conflict: clash
          ? { kind: "clash", ...clash }
          : !row.hidden && row.deleted
            ? { kind: "deleted_live" }
            : relocated
              ? { kind: "relocated" }
              : { kind: "none" },
      };
    });
  }

  async function lineage(view: TreeView, id: DocumentId): Promise<DocumentLineage | null> {
    if (!isUuid(id)) return null;
    const [shown] = await documentRows(view, (vd) => eq(vd.id, id));
    const [row] = shown ? [] : await loadDocumentIdentityRows(tx(), [id]);
    const located = shown ?? (row && !row.hidden && row.deleted ? row : null);
    if (!located) return null;
    const chains = await loadFolderChains(tx(), [located.folderId]);
    const chain = located.folderId === null ? [] : (chains.get(located.folderId) ?? []);
    return {
      status: shown ? "visible" : "deleted",
      contextSourceId: located.contextSourceId,
      folders: chain.map((folder) => ({ id: folder.id, deleted: folder.deleted })),
    };
  }

  return {
    resolvePath,
    findById,
    findFolderById,
    identityStatus,
    occupantsAt,
    treeState,
    lineage,
    projectOfDocument: (id) => projectOfDocument(tx(), id),
  };
}

type Position = {
  key: number;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  filename: string;
};

function positionValues(positions: readonly Position[]): SQL {
  return sql.join(
    positions.map(
      (position) =>
        sql`(${position.key}::int, ${position.contextSourceId}::uuid, ${position.folderId}::uuid, ${position.filename}::text)`,
    ),
    sql`, `,
  );
}

function nodeId(node: TreeNode): string {
  return node.kind === "document" ? node.document.id : node.folder.id;
}

function rowLocation(
  row: Pick<
    DocumentIdentityRow,
    "id" | "contextSourceId" | "folderId" | "name" | "extension" | "fileType"
  >,
): NodeLocation {
  return {
    documentId: row.id,
    contextSourceId: row.contextSourceId,
    folderId: row.folderId,
    name: row.name,
    extension: row.extension,
    fileType: row.fileType,
  };
}

function draftedLocation(row: DocumentIdentityRow, draft: DraftLocation): NodeLocation {
  return draft.contextSourceId === null
    ? rowLocation(row)
    : {
        documentId: row.id,
        contextSourceId: draft.contextSourceId,
        folderId: draft.parentFolderId,
        name: draft.name ?? row.name,
        extension: draft.extension ?? row.extension,
        fileType: row.fileType,
      };
}

function draftUse(use: Awaited<ReturnType<typeof loadActiveDraftUses>>[number]) {
  return {
    use: { draftId: use.draftId, originWorkId: use.originWorkId, createdAt: use.draftCreatedAt },
    location: use as DraftLocation,
  };
}
