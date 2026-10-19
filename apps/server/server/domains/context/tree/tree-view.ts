/**
 * The tree view: which documents and folders a reader sees, live or in one branch
 * (target model "Readers"). A hidden node is in no live view; in a branch that created
 * it, it is an ordinary node at the branch's location. Readers select from
 * `visibleDocuments(view)` / `visibleFolders(view)` or ask the `TreeReader`; neither
 * they nor anything outside this module reads the hidden column.
 */
import type {
  BranchId,
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  WorkId,
} from "@meridian/contracts";
import { folderDocumentName } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { isStorageBackedDocument } from "../adapters/catalog-file-mapper.js";
import { renderFilename } from "../context/paths.js";
import type { HiddenNodeRepair } from "./hidden-node-repair.js";
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
  identityDocuments,
  loadActiveBranchUses,
  loadBranchCreatedDocuments,
  loadDocumentIdentityRows,
  loadDocumentIdsAt,
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
  identityFolderFields,
  identityFolders,
  livingDocumentUses,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocumentFields,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
  visibleFoldersSql,
} from "./tree-view-sql.js";

export type TreeView = { kind: "live" } | { kind: "branch"; branchId: BranchId };
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

/**
 * A path asked as a claim of one kind also meets the shared document and folder namespace
 * (`namespaceName`). Creates, placements, moves, Apply's holds and `treeState`'s clash
 * diagnostics ask this way; browsing (ls, stat, read, a link's resolution) resolves
 * literally and never does.
 */
export type NameClaim = "document" | "folder";

/**
 * The one shared-namespace rule: the document filename a node of this kind holds under its
 * parent. A document holds its own filename; a folder holds its document alias (folder
 * `Lore.md` holds document `Lore`). A document and a folder meet when these are equal; two
 * folders, or two documents, meet only literally (`Lore` and `Lore.md` may both be folders).
 */
export function namespaceName(kind: NameClaim, filename: string): string {
  return kind === "folder" ? folderDocumentName(filename) : filename;
}

/** A path to resolve; `as` makes it a claim of that kind. */
export type PathQuery = { contextSourceId: ContextSourceId; path: string; as?: NameClaim };

export type PathResolution<N> =
  | { kind: "found"; node: N }
  /** Two or more visible nodes at one path in this view. */
  | { kind: "ambiguous"; nodes: readonly [NodeRef, NodeRef, ...NodeRef[]] }
  | { kind: "not_found" };

export type TreeNode =
  | { kind: "document"; document: VisibleDocument }
  | { kind: "folder"; folder: VisibleFolder };

export type BranchUse = { branchId: BranchId; originWorkId: WorkId | null; createdAt: Date };

export type IdentityStatus =
  /**
   * Visible in this view, at `address` in this view. A hidden one is visible only in a
   * branch that uses it: `branch` is that branch (the document still reads "in a draft").
   */
  | { kind: "visible"; address: NodeAddress; hidden: boolean; branch?: BranchUse }
  /**
   * Hidden and not used by this view's branch. `branch` is the reader's own if it uses it,
   * otherwise the oldest active branch that uses it; `address` is where that branch has it.
   * No content access, no path occupancy.
   */
  | {
      kind: "hidden";
      documentId: DocumentId;
      branch: BranchUse;
      usedBy: readonly BranchUse[];
      address: NodeAddress;
    }
  /** Soft-deleted while visible; the last address it held (decision 15). */
  | { kind: "deleted"; documentId: DocumentId; lastAddress: NodeAddress | null }
  /** A tombstone, a hidden node no branch uses, a missing id, or an address that can't be spelled. */
  | { kind: "gone"; documentId: DocumentId };

export type TreeStateNode = {
  nodeKind: "document";
  nodeId: DocumentId;
  /** created: the branch has a `created` row. edited: the caller names it (text only). */
  origin: "created" | "edited";
  /** Created and still hidden: "new". */
  hidden: boolean;
  binary: boolean;
  fileType: string;
  /** Soft-deleted live: Apply holds it with the removal's record and revives nothing. */
  deleted: boolean;
  /** The row's own location, the only one a document has: where Apply reveals it. */
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
     * 5a (F11): a different node visible in the branch holds the target path, or a
     * document holds the path of a folder the target needs.
     */
    | { kind: "clash"; withNode: NodeRef; at: string; uri: string | null }
    /** Created-and-revealed or edited, then deleted live: Apply holds it, reviving nothing. */
    | { kind: "deleted_live" };
};

export type DocumentLineage = {
  status: "visible" | "deleted";
  contextSourceId: ContextSourceId;
  /** The document's folder and its ancestors, nearest first. */
  folders: readonly { id: FolderId; deleted: boolean }[];
};

export interface TreeReader {
  resolvePath(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  /**
   * One step of a walk: what this view shows named `filename` directly under `parentId`
   * (null: the source root). The same answer as `resolvePath` at that folder's path plus
   * `filename`, without walking down from the root again.
   */
  childAt(
    view: TreeView,
    at: {
      contextSourceId: ContextSourceId;
      parentId: FolderId | null;
      filename: string;
      as?: NameClaim;
    },
  ): Promise<PathResolution<NodeRef>>;
  /**
   * What this view shows at each source-relative path, in input order: the documents and
   * the folders there (more than one of either when they clash).
   */
  occupancy(
    view: TreeView,
    at: readonly PathQuery[],
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
   * The branch's created documents, plus the edited documents the caller names (the
   * branch's drafts with rows; the tree view doesn't read drafts). `only` limits the
   * created ones to these ids, so one item's lookup costs one item.
   */
  treeState(
    branchId: BranchId,
    edited?: readonly DocumentId[],
    only?: readonly DocumentId[],
  ): Promise<TreeStateNode[]>;
  /** File facts: in this view, its folder chain; deleted, its last chain; else null. */
  lineage(view: TreeView, id: DocumentId): Promise<DocumentLineage | null>;
  /** The same lineage facts for a set, with one bulk folder-chain read. */
  lineages(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentLineage>>;
  projectOfDocument(id: DocumentId): Promise<ProjectId | null>;
}

/** The key `occupantsAt` answers under. */
export function coordinatesKey(
  at: Pick<
    DocumentCoordinates,
    "projectId" | "scheme" | "workId" | "rootThreadId" | "chatThreadId" | "path"
  >,
): string {
  return JSON.stringify([
    at.projectId,
    at.scheme,
    at.workId,
    at.rootThreadId ?? null,
    at.chatThreadId ?? null,
    at.path,
  ]);
}

type VisibleDocumentRow = Omit<VisibleDocument, "path"> & {
  createdAt: Date;
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

/**
 * `repair`: where `identityStatus` sends a hidden, live document no active branch uses (an
 * inconsistent row it answers `gone` for) to be tombstoned after the read (§12.4).
 */
export function createTreeReader(
  db: Database,
  options: { repair?: Pick<HiddenNodeRepair, "schedule"> } = {},
): TreeReader {
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
    queries: readonly PathQuery[],
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
    const aliases = await aliasOccupants(
      view,
      walks.map((walk, owner) => ({ ...walk, as: queries[owner]?.as })),
    );
    return walks.map((walk, owner) => ({
      path: walk.path,
      documents: [
        ...new Set([...leaves.idsFor(owner, documentHits), ...(aliases[owner]?.documents ?? [])]),
      ],
      folders: [
        ...new Set([...leaves.idsFor(owner, folderHits), ...(aliases[owner]?.folders ?? [])]),
      ],
    }));
  }

  /**
   * The nodes a claim meets through the shared namespace alone (`NameClaim`), for each
   * leaf name under its candidate parents. Literal occupants are the caller's.
   */
  async function aliasOccupants(
    view: TreeView,
    asks: readonly {
      sourceId: ContextSourceId;
      parents: readonly (FolderId | null)[];
      filename: string;
      as?: NameClaim | undefined;
    }[],
  ): Promise<{ documents: DocumentId[]; folders: FolderId[] }[]> {
    const parentKey = (sourceId: string, parentId: string | null) =>
      JSON.stringify([sourceId, parentId]);
    // Folders whose document alias is a claimed document's name: every folder under the
    // parent, since an alias may carry any run of prose suffixes.
    const folderParents = new Map<
      string,
      { sourceId: ContextSourceId; parentId: FolderId | null }
    >();
    for (const ask of asks) {
      if (ask.as !== "document") continue;
      for (const parentId of ask.parents) {
        folderParents.set(parentKey(ask.sourceId, parentId), { sourceId: ask.sourceId, parentId });
      }
    }
    const siblings =
      folderParents.size === 0
        ? []
        : await folderRows(view, (vf) =>
            or(
              ...[...folderParents.values()].map((at) =>
                and(
                  eq(vf.contextSourceId, at.sourceId),
                  at.parentId === null ? isNull(vf.parentId) : eq(vf.parentId, at.parentId),
                ),
              ),
            ),
          );
    // The document at a claimed folder name's alias.
    const documentAsks = positions(
      asks.flatMap((ask, owner) => {
        const alias = namespaceName("folder", ask.filename);
        return ask.as === "folder" && alias !== ask.filename
          ? ask.parents.map((parentId) => ({
              owner,
              sourceId: ask.sourceId,
              parentId,
              name: alias,
            }))
          : [];
      }),
    );
    const documentHits = await loadDocumentIdsAt(
      tx(),
      view,
      documentAsks.slots.flatMap((slot) =>
        filenameSplits(slot.name).map((split) => ({ ...slot, ...split })),
      ),
    );
    return asks.map((ask, owner) => {
      const parents = new Set(ask.parents.map((parentId) => parentKey(ask.sourceId, parentId)));
      return {
        documents: documentAsks.idsFor(owner, documentHits),
        folders:
          ask.as === "document"
            ? siblings
                .filter(
                  (folder) =>
                    parents.has(parentKey(folder.contextSourceId, folder.parentId)) &&
                    folder.name !== ask.filename &&
                    namespaceName("folder", folder.name) ===
                      namespaceName("document", ask.filename),
                )
                .map((folder) => folder.id)
            : [],
      };
    });
  }

  async function resolvePath(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>> {
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
    at: {
      contextSourceId: ContextSourceId;
      parentId: FolderId | null;
      filename: string;
      as?: NameClaim;
    },
  ): Promise<PathResolution<NodeRef>> {
    const slot = { key: 0, sourceId: at.contextSourceId, parentId: at.parentId, name: at.filename };
    const documentHits = await loadDocumentIdsAt(
      tx(),
      view,
      filenameSplits(at.filename).map((split) => ({ ...slot, ...split })),
    );
    const folderHits = await loadFolderIdsAt(tx(), view, [slot]);
    const [alias] = at.as
      ? await aliasOccupants(view, [
          {
            sourceId: at.contextSourceId,
            parents: [at.parentId],
            filename: at.filename,
            as: at.as,
          },
        ])
      : [];
    const [first, second, ...rest] = [
      ...[...new Set([...documentHits.map((hit) => hit.id), ...(alias?.documents ?? [])])].map(
        (id): NodeRef => ({ kind: "document", id }),
      ),
      ...[...new Set([...folderHits.map((hit) => hit.id), ...(alias?.folders ?? [])])].map(
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
    const uses = new Map<DocumentId, BranchUse[]>();
    for (const use of await loadActiveBranchUses(tx(), hiddenIds)) {
      uses.set(use.documentId, [...(uses.get(use.documentId) ?? []), branchUse(use)]);
    }

    // Decide first, then spell every chosen location in one batch.
    type Pending =
      | { kind: "visible"; location: NodeLocation; hidden: boolean; branch?: BranchUse }
      | { kind: "hidden"; location: NodeLocation; branch: BranchUse; usedBy: BranchUse[] }
      | { kind: "deleted"; location: NodeLocation }
      | { kind: "gone" };
    const decided = new Map<DocumentId, Pending>();
    const unused: DocumentId[] = [];
    for (const id of unique) {
      const row = rows.get(id);
      const shown = visible.get(id);
      if (!row || (row.hidden && row.deleted)) {
        decided.set(id, { kind: "gone" });
      } else if (shown) {
        const own =
          row.hidden && view.kind === "branch"
            ? uses.get(id)?.find((use) => use.branchId === view.branchId)
            : undefined;
        decided.set(id, {
          kind: "visible",
          location: rowLocation(shown),
          hidden: row.hidden,
          ...(own ? { branch: own } : {}),
        });
      } else if (row.hidden) {
        const usedBy = uses.get(id) ?? [];
        const chosen =
          (view.kind === "branch" && usedBy.find((use) => use.branchId === view.branchId)) ||
          usedBy[0];
        decided.set(
          id,
          chosen
            ? {
                kind: "hidden",
                location: rowLocation(row),
                branch: chosen,
                usedBy,
              }
            : { kind: "gone" },
        );
        if (!chosen) unused.push(id);
      } else if (row.deleted) {
        decided.set(id, { kind: "deleted", location: rowLocation(row) });
      } else {
        decided.set(id, { kind: "gone" });
      }
    }
    options.repair?.schedule(unused);
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
          ...(pending.branch ? { branch: pending.branch } : {}),
        });
      } else {
        out.set(id, {
          kind: "hidden",
          documentId: id,
          branch: pending.branch,
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
      const key = JSON.stringify([
        at.projectId,
        at.scheme,
        at.workId,
        at.rootThreadId ?? null,
        at.chatThreadId ?? null,
      ]);
      const known =
        sources.get(key) ??
        presentSourceId(tx(), {
          scheme: at.scheme,
          workId: at.workId,
          rootThreadId: at.rootThreadId ?? null,
          chatThreadId: at.chatThreadId ?? null,
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
    branchId: BranchId,
    edited: readonly DocumentId[] = [],
    only?: readonly DocumentId[],
  ): Promise<TreeStateNode[]> {
    const view: TreeView = { kind: "branch", branchId };
    const created = isUuid(branchId)
      ? await loadBranchCreatedDocuments(tx(), branchId, only?.filter(isUuid))
      : [];
    const createdIds = new Set(created.map((row) => row.id));
    const editedRows = await loadDocumentIdentityRows(
      tx(),
      [...new Set(edited)].filter((id) => isUuid(id) && !createdIds.has(id)),
    );
    const items: { origin: "created" | "edited"; row: DocumentIdentityRow }[] = [
      // A tombstone is no longer the branch's: repair-on-touch drops its row (§12.4).
      ...created
        .filter((row) => !(row.hidden && row.deleted))
        .map((row) => ({ origin: "created" as const, row })),
      // A hidden document the branch didn't create isn't in the branch's view.
      ...editedRows.filter((row) => !row.hidden).map((row) => ({ origin: "edited" as const, row })),
    ];
    const chains = await loadFolderChains(
      tx(),
      items.map(({ row }) => row.folderId),
    );
    const chainOf = (folderId: FolderId | null) =>
      folderId === null ? [] : (chains.get(folderId) ?? []);

    // Every path a target needs, in the branch's view: its own, then each ancestor folder's,
    // nearest first. Paths, not folder ids: a deleted folder's path may hold a new folder.
    // Each is a claim of its kind, so the clash is the one Apply's live holds would see.
    const needs = items.flatMap(({ row }, item) => {
      const segments = folderPath(
        chainOf(row.folderId),
        renderFilename(row.name, row.extension),
      ).split("/");
      return segments.map((_, drop) => ({
        item,
        target: drop === 0,
        contextSourceId: row.contextSourceId,
        path: segments.slice(0, segments.length - drop).join("/"),
        as: drop === 0 ? ("document" as const) : ("folder" as const),
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

    // Spelled from the same read as the paths and the version token.
    const spelled = await spellNodeAddresses(
      tx(),
      items.map(({ row }) => rowLocation(row)),
      chains,
    );

    return items.map(({ origin, row }, item): TreeStateNode => {
      const chain = chainOf(row.folderId);
      const clash = clashOf(item);
      const address = spelled[item]?.uri ?? null;
      const path = folderPath(chain, renderFilename(row.name, row.extension));
      return {
        nodeKind: "document",
        nodeId: row.id,
        origin,
        hidden: row.hidden,
        binary: isStorageBackedDocument(row),
        fileType: row.fileType,
        deleted: row.deleted,
        target: {
          contextSourceId: row.contextSourceId,
          parentFolderId: row.folderId,
          name: row.name,
          extension: row.extension,
          path,
          dir: [...chain].reverse().map((folder) => folder.name),
          uri: address,
        },
        locationVersion: row.locationVersion,
        conflict: clash
          ? {
              kind: "clash",
              ...clash,
              uri: sameSourceUri(address, path, clash.at),
            }
          : !row.hidden && row.deleted
            ? { kind: "deleted_live" }
            : { kind: "none" },
      };
    });
  }

  async function lineages(view: TreeView, documentIds: readonly DocumentId[]) {
    const ids = [...new Set(documentIds)].filter(isUuid);
    const out = new Map<DocumentId, DocumentLineage>();
    if (ids.length === 0) return out;
    const identities = identityDocuments(view);
    const located = await tx()
      .select({
        id: identities.id,
        contextSourceId: identities.contextSourceId,
        folderId: identities.folderId,
        deletedAt: identities.deletedAt,
      })
      .from(identities)
      .where(inArray(identities.id, ids));
    const chains = await loadFolderChains(
      tx(),
      located.map((row) => row.folderId),
    );
    for (const row of located) {
      const chain = row.folderId === null ? [] : (chains.get(row.folderId) ?? []);
      out.set(row.id, {
        status: row.deletedAt ? "deleted" : "visible",
        contextSourceId: row.contextSourceId,
        folders: chain.map((folder) => ({ id: folder.id, deleted: folder.deleted })),
      });
    }
    return out;
  }

  async function lineage(view: TreeView, id: DocumentId): Promise<DocumentLineage | null> {
    return (await lineages(view, [id])).get(id) ?? null;
  }

  async function occupancy(view: TreeView, at: readonly PathQuery[]) {
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
    lineages,
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

function branchUse(use: Awaited<ReturnType<typeof loadActiveBranchUses>>[number]): BranchUse {
  return { branchId: use.branchId, originWorkId: use.originWorkId, createdAt: use.branchCreatedAt };
}
