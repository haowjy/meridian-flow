/**
 * The tree view: which documents and folders a reader sees, live or in one Work's tree.
 * Readers select from `visibleDocuments(view)` / `visibleFolders(view)` (`tree-relations.ts`)
 * or ask the `TreeReader`. A node's filename is its `name`, extension included; a document
 * the view does not place (in Trash, deleted in the Work, or in no view) is never visible,
 * and one in no view has no place at all.
 */
import type { ContextSourceId, DocumentId, FolderId, ProjectId } from "@meridian/contracts";
import { addressCandidates } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { inArray, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import {
  chainPrefix,
  type DocumentCoordinates,
  loadFolderChains,
  type NodeAddress,
  type NodeLocation,
  placedNodesSql,
  presentSourceId,
  projectOfDocument,
  spellNodeAddresses,
} from "./tree-addresses.js";
import {
  type TreeView,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
  visibleFoldersSql,
} from "./tree-relations.js";

export type { DocumentCoordinates, NodeAddress } from "./tree-addresses.js";
export {
  LIVE_TREE,
  type TreeView,
  type VisibleDocumentsSubquery,
  type VisibleFoldersSubquery,
  visibleDocumentFields,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
  visibleFoldersSql,
} from "./tree-relations.js";

export type NodeRef = { kind: "document"; id: DocumentId } | { kind: "folder"; id: FolderId };

export type VisibleDocument = {
  id: DocumentId;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  /** The filename as the view shows it, extension included: never render it with an extension. */
  name: string;
  /** What follows the last dot of the name, lowercased; empty when the name has none. */
  extension: string;
  fileType: string;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  hasPreview: boolean;
  metadata: JsonObject;
  rank: string;
  locationVersion: bigint;
  updatedAt: Date;
  /** Source-relative path in this view. */
  path: string;
};

export type VisibleFolder = {
  id: FolderId;
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
  rank: string;
  locationVersion: bigint;
  path: string;
};

/** A source-relative path to resolve. */
export type PathQuery = { contextSourceId: ContextSourceId; path: string };

export type PathResolution<N> =
  | { kind: "found"; node: N }
  /** Two or more visible nodes at one path in this view. */
  | { kind: "ambiguous"; nodes: readonly [NodeRef, NodeRef, ...NodeRef[]] }
  | { kind: "not_found" };

export type TreeNode =
  | { kind: "document"; document: VisibleDocument }
  | { kind: "folder"; folder: VisibleFolder };

export type IdentityStatus =
  /** Visible in this view, at `address` in this view. */
  | { kind: "visible"; address: NodeAddress; existsOnlyInDraft: boolean }
  /** In Trash, or deleted in this Work's tree; the last address it held. */
  | { kind: "deleted"; documentId: DocumentId; lastAddress: NodeAddress | null }
  /** In no view, a missing id, or an address that can't be spelled. */
  | { kind: "gone"; documentId: DocumentId };

export type DocumentLineage = {
  /** In this view: deleted when it is in Trash or the Work's tree deleted it. */
  status: "visible" | "deleted";
  /** Live has it in Trash, whatever this view shows. */
  inTrash: boolean;
  contextSourceId: ContextSourceId;
  /** The document's folder and its ancestors, nearest first. */
  folders: readonly { id: FolderId; deleted: boolean }[];
};

export interface TreeReader {
  resolvePath(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  /**
   * `resolvePath` for a spelling a writer or model typed: whatever holds the literal name
   * (a folder `ch1.md`, a file kept as `binary.md`), else whatever holds the codec's alias
   * (`ch1.md` is `ch1`).
   */
  resolveAddress(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  /**
   * `resolveAddress` for a caller that wants a document (a link, a read): `Lore.md` reaches
   * document `Lore` even beside a folder `Lore.md`. A folder never answers.
   */
  resolveDocumentAddress(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  /**
   * One step of a walk: what this view shows named `filename` directly under `parentId`
   * (null: the source root).
   */
  childAt(
    view: TreeView,
    at: {
      contextSourceId: ContextSourceId;
      parentId: FolderId | null;
      filename: string;
    },
  ): Promise<PathResolution<NodeRef>>;
  findById(
    view: TreeView,
    id: DocumentId,
  ): Promise<{ kind: "found"; document: VisibleDocument } | { kind: "not_found" }>;
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
  /** File facts: in this view, its folder chain; deleted, its last chain; else absent. */
  lineages(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentLineage>>;
  /** The project that owns the document, whether or not a view places it. */
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

type NodeSlot = {
  key: number;
  sourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
};

/**
 * The ids of the nodes of one kind that the view shows at each slot (source, parent, name).
 * One statement for any number of slots: each is a `LATERAL ... OFFSET 0` probe of the
 * relation, which keeps a Work's union planned as index probes (see the store page).
 */
async function nodesAt(
  db: DrizzleDb,
  view: TreeView,
  kind: "document" | "folder",
  slots: readonly NodeSlot[],
): Promise<{ key: number; id: string }[]> {
  if (slots.length === 0) return [];
  const relation = kind === "document" ? visibleDocumentsSql(view) : visibleFoldersSql(view);
  const parentColumn = sql.raw(kind === "document" ? "r.folder_id" : "r.parent_id");
  const probe = (rooted: boolean): SQL | null => {
    const mine = slots.filter((slot) => (slot.parentId === null) === rooted);
    if (mine.length === 0) return null;
    const values = sql.join(
      mine.map((slot) =>
        rooted
          ? sql`(${slot.key}::int, ${slot.sourceId}::uuid, ${slot.name}::text)`
          : sql`(${slot.key}::int, ${slot.sourceId}::uuid, ${slot.name}::text, ${slot.parentId}::uuid)`,
      ),
      sql`, `,
    );
    return sql`SELECT s.key, n.id::text AS id
      FROM (VALUES ${values}) AS s(${sql.raw(rooted ? "key, source_id, name" : "key, source_id, name, parent_id")})
      CROSS JOIN LATERAL (
        SELECT r.id FROM ${relation} r
        WHERE r.context_source_id = s.source_id AND r.name = s.name
          AND ${rooted ? sql`${parentColumn} IS NULL` : sql`${parentColumn} = s.parent_id`}
        OFFSET 0
      ) n`;
  };
  const statements = [probe(true), probe(false)].filter((each): each is SQL => each !== null);
  return [
    ...(await db.execute<{ key: number; id: string }>(sql.join(statements, sql` UNION ALL `))),
  ];
}

type PathOccupancy = {
  path: string;
  documents: DocumentId[];
  folders: FolderId[];
};

export function createTreeReader(db: Database): TreeReader {
  const tx = (): DrizzleDb => currentDrizzleDb(db);

  async function documentRows(
    view: TreeView,
    where: (vd: VisibleDocumentsSubquery) => SQL | undefined,
  ) {
    const vd = visibleDocuments(view);
    return tx().select().from(vd).where(where(vd));
  }

  async function folderRows(
    view: TreeView,
    where: (vf: VisibleFoldersSubquery) => SQL | undefined,
  ) {
    const vf = visibleFolders(view);
    return tx().select().from(vf).where(where(vf));
  }

  function toDocument(
    row: Awaited<ReturnType<typeof documentRows>>[number],
    path: string,
  ): VisibleDocument {
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
      hasPreview: row.hasPreview,
      metadata: row.metadata,
      rank: row.rank,
      locationVersion: row.locationVersion,
      updatedAt: row.updatedAt,
      path,
    };
  }

  /**
   * The one meaning of "same path": the ids of every node the view shows at each source-relative
   * path, walked one level at a time through the view's folders by name (one statement per
   * depth for the whole batch, then one for the documents and one for the folders).
   */
  async function pathOccupants(
    view: TreeView,
    queries: readonly PathQuery[],
  ): Promise<PathOccupancy[]> {
    const walks = queries.map((query) => {
      const segments = query.path.split("/").filter(Boolean);
      const filename = segments.pop();
      return {
        sourceId: query.contextSourceId,
        path: [...segments, ...(filename === undefined ? [] : [filename])].join("/"),
        dirs: segments,
        filename: filename ?? "",
        parents:
          filename !== undefined && isUuid(query.contextSourceId)
            ? [null]
            : ([] as (FolderId | null)[]),
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
      const hits = await nodesAt(tx(), view, "folder", asked.slots);
      walks.forEach((walk, owner) => {
        if (level < walk.dirs.length) walk.parents = asked.idsFor(owner, hits) as FolderId[];
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
    const [documentHits, folderHits] = await Promise.all([
      nodesAt(tx(), view, "document", leaves.slots),
      nodesAt(tx(), view, "folder", leaves.slots),
    ]);
    return walks.map((walk, owner) => ({
      path: walk.path,
      documents: leaves.idsFor(owner, documentHits) as DocumentId[],
      folders: leaves.idsFor(owner, folderHits) as FolderId[],
    }));
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
    },
  ): Promise<PathResolution<NodeRef>> {
    const slot = [
      { key: 0, sourceId: at.contextSourceId, parentId: at.parentId, name: at.filename },
    ];
    const [documentHits, folderHits] = await Promise.all([
      nodesAt(tx(), view, "document", slot),
      nodesAt(tx(), view, "folder", slot),
    ]);
    const [first, second, ...rest] = [
      ...documentHits.map((hit): NodeRef => ({ kind: "document", id: hit.id as DocumentId })),
      ...folderHits.map((hit): NodeRef => ({ kind: "folder", id: hit.id as FolderId })),
    ];
    if (!first) return { kind: "not_found" };
    if (!second) return { kind: "found", node: first };
    return { kind: "ambiguous", nodes: [first, second, ...rest] };
  }

  async function findById(view: TreeView, id: DocumentId) {
    if (!isUuid(id)) return { kind: "not_found" } as const;
    const [row] = await documentRows(view, (vd) => inArray(vd.id, [id]));
    if (!row) return { kind: "not_found" } as const;
    const chains = await loadFolderChains(tx(), [row.folderId], view);
    const path =
      chainPrefix(row.folderId === null ? [] : (chains.get(row.folderId) ?? [])) + row.name;
    return { kind: "found", document: toDocument(row, path) } as const;
  }

  async function findFolderById(view: TreeView, id: FolderId): Promise<VisibleFolder | null> {
    if (!isUuid(id)) return null;
    const [row] = await folderRows(view, (vf) => inArray(vf.id, [id]));
    if (!row) return null;
    const chain = (await loadFolderChains(tx(), [row.id], view)).get(row.id) ?? [];
    return { ...row, path: chainPrefix(chain).slice(0, -1) };
  }

  /** The documents the view places, deleted ones included. */
  async function placedDocuments(view: TreeView, ids: readonly DocumentId[]) {
    if (ids.length === 0) return [];
    const rows = await tx().execute<{
      id: string;
      context_source_id: string;
      parent_id: string | null;
      name: string;
      file_type: string;
      deleted: boolean;
      exists_only_in_draft: boolean;
      in_trash: boolean;
    }>(sql`
      SELECT n.id::text AS id, n.context_source_id::text AS context_source_id,
        n.parent_id::text AS parent_id, n.name, n.file_type, n.deleted, n.exists_only_in_draft,
        lt.trash_record IS NOT NULL AS in_trash
      FROM ${placedNodesSql(view)} n LEFT JOIN tree_nodes lt ON lt.id = n.id
      WHERE n.kind = 'document' AND n.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
    return rows.map((row) => ({
      id: row.id as DocumentId,
      location: {
        documentId: row.id as DocumentId,
        contextSourceId: row.context_source_id as ContextSourceId,
        folderId: row.parent_id as FolderId | null,
        name: row.name,
        fileType: row.file_type,
      } satisfies NodeLocation,
      deleted: row.deleted,
      existsOnlyInDraft: row.exists_only_in_draft,
      inTrash: row.in_trash,
    }));
  }

  async function identityStatus(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, IdentityStatus>> {
    const unique = [...new Set(ids)];
    const placed = await placedDocuments(view, unique.filter(isUuid));
    const addresses = await spellNodeAddresses(
      tx(),
      placed.map((row) => row.location),
      await loadFolderChains(
        tx(),
        placed.map((row) => row.location.folderId),
        view,
      ),
    );
    const out = new Map<DocumentId, IdentityStatus>(
      unique.map((id) => [id, { kind: "gone", documentId: id }]),
    );
    placed.forEach((row, index) => {
      const address = addresses[index] ?? null;
      if (row.deleted) {
        out.set(row.id, { kind: "deleted", documentId: row.id, lastAddress: address });
      } else if (address) {
        out.set(row.id, {
          kind: "visible",
          address,
          existsOnlyInDraft: row.existsOnlyInDraft,
        });
      }
    });
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

  async function lineages(view: TreeView, documentIds: readonly DocumentId[]) {
    const out = new Map<DocumentId, DocumentLineage>();
    const placed = await placedDocuments(view, [...new Set(documentIds)].filter(isUuid));
    const chains = await loadFolderChains(
      tx(),
      placed.map((row) => row.location.folderId),
      view,
    );
    for (const row of placed) {
      const folderId = row.location.folderId;
      const chain = folderId === null ? [] : (chains.get(folderId) ?? []);
      out.set(row.id, {
        status: row.deleted ? "deleted" : "visible",
        inTrash: row.inTrash,
        contextSourceId: row.location.contextSourceId,
        folders: chain.map((folder) => ({ id: folder.id, deleted: folder.deleted })),
      });
    }
    return out;
  }

  async function resolveAddress(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>> {
    const slash = at.path.lastIndexOf("/");
    const leaves = addressCandidates(at.path.slice(slash + 1));
    let first: PathResolution<TreeNode> = { kind: "not_found" };
    for (const [i, leaf] of leaves.entries()) {
      const found = await resolvePath(view, { ...at, path: at.path.slice(0, slash + 1) + leaf });
      if (found.kind !== "not_found") return found;
      if (i === 0) first = found;
    }
    return first;
  }

  async function resolveDocumentAddress(
    view: TreeView,
    at: PathQuery,
  ): Promise<PathResolution<TreeNode>> {
    const slash = at.path.lastIndexOf("/");
    for (const leaf of addressCandidates(at.path.slice(slash + 1))) {
      const found = await resolvePath(view, { ...at, path: at.path.slice(0, slash + 1) + leaf });
      if (found.kind === "ambiguous" || (found.kind === "found" && found.node.kind === "document"))
        return found;
    }
    return { kind: "not_found" };
  }

  return {
    resolvePath,
    resolveAddress,
    resolveDocumentAddress,
    childAt,
    findById,
    findFolderById,
    identityStatus,
    occupantsAt,
    lineages,
    projectOfDocument: (id) => projectOfDocument(tx(), id),
  };
}

/**
 * Number each distinct position once and fan hits back out to every walk that asked it.
 */
function positions(asks: readonly (Omit<NodeSlot, "key"> & { owner: number })[]) {
  const keys = new Map<string, number>();
  const slots: NodeSlot[] = [];
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
    idsFor(owner: number, hits: readonly { key: number; id: string }[]): string[] {
      const asked = new Set(owners.get(owner) ?? []);
      return [...new Set(hits.filter((hit) => asked.has(hit.key)).map((hit) => hit.id))];
    },
  };
}

/** The identity of a node a reader found. */
export function refOf(node: TreeNode): NodeRef {
  return node.kind === "document"
    ? { kind: "document", id: node.document.id }
    : { kind: "folder", id: node.folder.id };
}
