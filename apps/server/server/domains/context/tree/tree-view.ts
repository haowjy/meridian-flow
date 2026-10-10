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
import { eq, inArray, type SQL } from "drizzle-orm";
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
  loadDocumentIdsAt,
  loadDraftCreatedDocuments,
  loadFolderIdsAt,
  type PathSlot,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocuments,
  visibleFolders,
} from "./tree-view-sql.js";

export type { DocumentCoordinates, NodeAddress } from "./tree-addresses.js";
export {
  identityDocumentFields,
  identityDocuments,
  identityFolders,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocumentFields,
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
  | { kind: "ambiguous"; nodes: readonly [NodeRef, NodeRef, ...NodeRef[]] }
  | { kind: "not_found" };

export type TreeNode =
  | { kind: "document"; document: VisibleDocument }
  | { kind: "folder"; folder: VisibleFolder };

export type DraftUse = { draftId: DraftId; originWorkId: WorkId | null; createdAt: Date };

export type IdentityStatus =
  /**
   * Visible in this view, at `address` in this view. A hidden one is visible only in a
   * draft that uses it: `draft` is that draft (the document still reads "in a draft").
   */
  | { kind: "visible"; address: NodeAddress; hidden: boolean; draft?: DraftUse }
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
    /** `path` spelled as a canonical URI; null when it can't be spelled. */
    uri: string | null;
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
    /** Folder names from the source root to the parent: a move target by path. */
    dir: readonly string[];
    /** `path` spelled as a canonical URI; null when it can't be spelled. */
    uri: string | null;
  };
  /** The rendered location token's source. */
  locationVersion: bigint;
  conflict:
    | { kind: "none" }
    /**
     * 5a (F11): a different node visible in the draft holds the target path, or a
     * document holds the path of a folder the target needs.
     */
    | { kind: "clash"; withNode: NodeRef; at: string; uri: string | null }
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
  /**
   * One step of a walk: what this view shows named `filename` directly under `parentId`
   * (null: the source root). The same answer as `resolvePath` at that folder's path plus
   * `filename`, without walking down from the root again.
   */
  childAt(
    view: TreeView,
    at: { contextSourceId: ContextSourceId; parentId: FolderId | null; filename: string },
  ): Promise<PathResolution<NodeRef>>;
  /**
   * What this view shows at each source-relative path, in input order: the documents and
   * the folders there (more than one of either when they clash).
   */
  occupancy(
    view: TreeView,
    at: readonly { contextSourceId: ContextSourceId; path: string }[],
  ): Promise<{ documents: DocumentId[]; folders: FolderId[] }[]>;
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
  at: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "rootThreadId" | "path">,
): string {
  return JSON.stringify([at.projectId, at.scheme, at.workId, at.rootThreadId ?? null, at.path]);
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

  /**
   * The one meaning of "same path": the ids of every node visible at each rendered
   * source-relative path in this view, walked through the view's visible folders by name
   * (every folder of a name, so absorbed twins are all followed) and matched by every
   * filename split. One query per folder depth for the whole batch, then one per kind;
   * identical positions are asked once.
   */
  async function pathOccupants(
    view: TreeView,
    queries: readonly { contextSourceId: ContextSourceId; path: string }[],
  ): Promise<PathOccupancy[]> {
    const walks = queries.map((query) => {
      const segments = query.path.split("/").filter(Boolean);
      const filename = segments.pop();
      const walkable = filename !== undefined && isUuid(query.contextSourceId);
      return {
        sourceId: query.contextSourceId,
        path: [...segments, ...(filename === undefined ? [] : [filename])].join("/"),
        dirs: segments,
        filename: filename ?? "",
        parents: walkable ? [null] : ([] as (FolderId | null)[]),
      };
    });
    const depth = Math.max(0, ...walks.map((walk) => walk.dirs.length));
    for (let level = 0; level < depth; level += 1) {
      const asked = positions(
        walks.flatMap((walk, owner) =>
          level < walk.dirs.length
            ? walk.parents.map((parentId) => ({
                owner,
                sourceId: walk.sourceId,
                parentId,
                name: walk.dirs[level] as string,
              }))
            : [],
        ),
      );
      const hits = await loadFolderIdsAt(tx(), view, asked.slots);
      walks.forEach((walk, owner) => {
        if (level < walk.dirs.length) walk.parents = asked.idsFor(owner, hits);
      });
    }
    const leaves = positions(
      walks.flatMap((walk, owner) =>
        walk.parents.map((parentId) => ({
          owner,
          sourceId: walk.sourceId,
          parentId,
          name: walk.filename,
        })),
      ),
    );
    const documentHits = await loadDocumentIdsAt(
      tx(),
      view,
      leaves.slots.flatMap((slot) =>
        filenameSplits(slot.name).map((split) => ({ ...slot, ...split })),
      ),
    );
    const folderHits = await loadFolderIdsAt(tx(), view, leaves.slots);
    return walks.map((walk, owner) => ({
      path: walk.path,
      documents: leaves.idsFor(owner, documentHits),
      folders: leaves.idsFor(owner, folderHits),
    }));
  }

  async function resolvePath(
    view: TreeView,
    at: { contextSourceId: ContextSourceId; path: string },
  ): Promise<PathResolution<TreeNode>> {
    const [found] = await pathOccupants(view, [at]);
    if (!found || found.documents.length + found.folders.length === 0) {
      return { kind: "not_found" };
    }
    const documents =
      found.documents.length === 0
        ? []
        : await documentRows(view, (vd) => inArray(vd.id, found.documents));
    const folders =
      found.folders.length === 0
        ? []
        : await folderRows(view, (vf) => inArray(vf.id, found.folders));
    const nodes: TreeNode[] = [
      ...documents.map((row) => ({
        kind: "document" as const,
        document: toDocument(row, found.path),
      })),
      ...folders.map((row) => ({
        kind: "folder" as const,
        folder: { ...row, path: found.path },
      })),
    ];
    const [first, second, ...rest] = nodes;
    if (!first) return { kind: "not_found" };
    if (!second) return { kind: "found", node: first };
    return { kind: "ambiguous", nodes: [refOf(first), refOf(second), ...rest.map(refOf)] };
  }

  async function childAt(
    view: TreeView,
    at: { contextSourceId: ContextSourceId; parentId: FolderId | null; filename: string },
  ): Promise<PathResolution<NodeRef>> {
    const slot = { key: 0, sourceId: at.contextSourceId, parentId: at.parentId, name: at.filename };
    const documentHits = await loadDocumentIdsAt(
      tx(),
      view,
      filenameSplits(at.filename).map((split) => ({ ...slot, ...split })),
    );
    const folderHits = await loadFolderIdsAt(tx(), view, [slot]);
    const [first, second, ...rest] = [
      ...[...new Set(documentHits.map((hit) => hit.id))].map(
        (id): NodeRef => ({ kind: "document", id }),
      ),
      ...[...new Set(folderHits.map((hit) => hit.id))].map(
        (id): NodeRef => ({ kind: "folder", id }),
      ),
    ];
    if (!first) return { kind: "not_found" };
    if (!second) return { kind: "found", node: first };
    return { kind: "ambiguous", nodes: [first, second, ...rest] };
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
    const [occupancy] = await pathOccupants(view, [{ contextSourceId: row.contextSourceId, path }]);
    return {
      kind: "found",
      document: toDocument(row, path),
      clashesWith: (occupancy?.documents ?? []).filter((other) => other !== id),
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
      .filter((row) => row.hidden && !row.deleted)
      .map((row) => row.id);
    const uses = new Map<DocumentId, ReturnType<typeof draftUse>[]>();
    for (const use of await loadActiveDraftUses(tx(), hiddenIds)) {
      uses.set(use.documentId, [...(uses.get(use.documentId) ?? []), draftUse(use)]);
    }

    // Decide first, then spell every chosen location in one batch.
    type Pending =
      | { kind: "visible"; location: NodeLocation; hidden: boolean; draft?: DraftUse }
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
        const own =
          row.hidden && view.kind === "draft"
            ? uses.get(id)?.find((use) => use.use.draftId === view.draftId)?.use
            : undefined;
        decided.set(id, {
          kind: "visible",
          location: rowLocation(shown),
          hidden: row.hidden,
          ...(own ? { draft: own } : {}),
        });
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
        out.set(id, {
          kind: "visible",
          address,
          hidden: pending.hidden,
          ...(pending.draft ? { draft: pending.draft } : {}),
        });
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
    const sources = new Map<string, Promise<ContextSourceId | null>>();
    const sourceOf = (at: DocumentCoordinates) => {
      const key = JSON.stringify([at.projectId, at.scheme, at.workId, at.rootThreadId ?? null]);
      const known =
        sources.get(key) ??
        presentSourceId(tx(), {
          scheme: at.scheme,
          workId: at.workId,
          rootThreadId: at.rootThreadId ?? null,
          project: { id: at.projectId },
        });
      sources.set(key, known);
      return known;
    };
    const unique = [...new Map(addresses.map((at) => [coordinatesKey(at), at])).values()];
    const located = await Promise.all(
      unique.map(async (at) => ({ at, sourceId: await sourceOf(at) })),
    );
    const queries = located.flatMap(({ at, sourceId }) =>
      sourceId ? [{ at, contextSourceId: sourceId, path: at.path }] : [],
    );
    const found = await pathOccupants(view, queries);
    const out = new Map<string, DocumentId[]>(unique.map((at) => [coordinatesKey(at), []]));
    queries.forEach((query, index) => {
      const occupancy = found[index];
      if (occupancy && occupancy.path === query.at.path) {
        out.set(coordinatesKey(query.at), occupancy.documents);
      }
    });
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

    // Every path a target needs, in the draft's view: its own, then each ancestor folder's,
    // nearest first. Paths, not folder ids: a deleted folder's path may hold a new folder.
    const needs = targets.flatMap((target, item) => {
      const path = folderPath(
        chainOf(target.parentFolderId),
        renderFilename(target.name, target.extension),
      );
      const segments = path.split("/");
      return segments.map((_, drop) => ({
        item,
        target: drop === 0,
        contextSourceId: target.contextSourceId,
        path: segments.slice(0, segments.length - drop).join("/"),
      }));
    });
    const occupied = await pathOccupants(view, needs);
    const clashOf = (item: number): { withNode: NodeRef; at: string } | null => {
      const nodeId = items[item]?.row.id;
      for (const [index, need] of needs.entries()) {
        if (need.item !== item) continue;
        const occupancy = occupied[index];
        const document = occupancy?.documents.find((other) => other !== nodeId);
        if (document) return { withNode: { kind: "document", id: document }, at: need.path };
        // A folder at an ancestor's path is the folder the target needs.
        const folder = need.target ? occupancy?.folders[0] : undefined;
        if (folder) return { withNode: { kind: "folder", id: folder }, at: need.path };
      }
      return null;
    };

    // Both locations spelled from the same read as the paths and the version token.
    const spelled = await spellNodeAddresses(
      tx(),
      items.flatMap(({ row }, item) => {
        const target = targets[item] as (typeof targets)[number];
        return [
          rowLocation(row),
          {
            ...rowLocation(row),
            contextSourceId: target.contextSourceId,
            folderId: target.parentFolderId,
            name: target.name,
            extension: target.extension,
          },
        ];
      }),
      chains,
    );

    return items.map(({ origin, row, draft }, item): TreeStateNode => {
      const target = targets[item] as (typeof targets)[number];
      const liveChain = chainOf(row.folderId);
      const clash = clashOf(item);
      const liveUri = spelled[item * 2]?.uri ?? null;
      const targetAddress = spelled[item * 2 + 1] ?? null;
      const targetPath = folderPath(
        chainOf(target.parentFolderId),
        renderFilename(target.name, target.extension),
      );
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
          uri: liveUri,
          deleted: row.deleted,
          deletedAncestors: liveChain.filter((folder) => folder.deleted).map((folder) => folder.id),
        },
        target: {
          ...target,
          path: targetPath,
          dir: [...chainOf(target.parentFolderId)].reverse().map((folder) => folder.name),
          uri: targetAddress?.uri ?? null,
        },
        locationVersion: row.locationVersion,
        conflict: clash
          ? {
              kind: "clash",
              ...clash,
              uri: sameSourceUri(targetAddress?.uri ?? null, targetPath, clash.at),
            }
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

  async function occupancy(
    view: TreeView,
    at: readonly { contextSourceId: ContextSourceId; path: string }[],
  ) {
    if (at.length === 0) return [];
    return (await pathOccupants(view, at)).map(({ documents, folders }) => ({
      documents,
      folders,
    }));
  }

  return {
    resolvePath,
    childAt,
    occupancy,
    findById,
    findFolderById,
    identityStatus,
    occupantsAt,
    treeState,
    lineage,
    projectOfDocument: (id) => projectOfDocument(tx(), id),
  };
}

type PathOccupancy = {
  /** The normalized source-relative path. */
  path: string;
  documents: DocumentId[];
  folders: FolderId[];
};

/**
 * Number each distinct position once and fan hits back out to every walk that asked it.
 */
function positions(asks: readonly (Omit<PathSlot, "key"> & { owner: number })[]) {
  const keys = new Map<string, number>();
  const slots: PathSlot[] = [];
  const owners = new Map<number, number[]>();
  for (const ask of asks) {
    const identity = JSON.stringify([ask.sourceId, ask.parentId, ask.name]);
    let key = keys.get(identity);
    if (key === undefined) {
      key = slots.length;
      keys.set(identity, key);
      slots.push({ key, sourceId: ask.sourceId, parentId: ask.parentId, name: ask.name });
    }
    owners.set(ask.owner, [...(owners.get(ask.owner) ?? []), key]);
  }
  return {
    slots,
    idsFor<I extends string>(owner: number, hits: readonly { key: number; id: I }[]): I[] {
      const asked = new Set(owners.get(owner) ?? []);
      return [...new Set(hits.filter((hit) => asked.has(hit.key)).map((hit) => hit.id))];
    },
  };
}

/**
 * `path` in the source `uri` (at `uriPath`) is spelled in: an ancestor path of a target
 * shares its scheme and authority.
 */
function sameSourceUri(uri: string | null, uriPath: string, path: string): string | null {
  if (!uri?.endsWith(uriPath)) return null;
  return uri.slice(0, uri.length - uriPath.length) + path;
}

/** The identity of a node a reader found. */
export function refOf(node: TreeNode): NodeRef {
  return node.kind === "document"
    ? { kind: "document", id: node.document.id }
    : { kind: "folder", id: node.folder.id };
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
