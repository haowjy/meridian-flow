/**
 * The tree view: which documents and folders a reader sees, live or in one Work's tree.
 * Readers select from `visibleDocuments(view)` / `visibleFolders(view)` (`tree-relations.ts`)
 * or ask the `TreeReader`. A node's filename is its `name`, extension included, and two siblings
 * may share it: a path walks `segment`s, the later twin's carrying `~` and the start of its id
 * (project-tree rule 14), so every path reaches one node. A document the view does not place (in Trash, deleted in the Work, or in no view) is never visible,
 * and one in no view has no place at all.
 */
import {
  type ContextSourceId,
  type DocumentId,
  type FolderId,
  matchOmittedExtension,
} from "@meridian/contracts";
import { addressCandidates, readSegment } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { TreeList } from "../ports/tree-list-store.js";
import {
  chainPrefix,
  type DocumentCoordinates,
  type FolderLink,
  loadFolderChains,
  type NodeAddress,
  type NodeLocation,
  ownerOfDocument,
  placedNodesSql,
  presentSourceId,
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
  /** The path segment: the name, and a later twin's `~` suffix. */
  segment: string;
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
  segment: string;
  rank: string;
  locationVersion: bigint;
  path: string;
};

/** A source-relative path to resolve. */
export type PathQuery = { contextSourceId: ContextSourceId; path: string };

export type PathResolution<N> = { kind: "found"; node: N } | { kind: "not_found" };

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
  folders: readonly FolderLink[];
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
   * One step of a walk: what this view shows at the segment `filename` directly under
   * `parentId` (null: the source root).
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
  /** Who owns the document, a project or an account, whether or not a view places it. */
  ownerOfDocument(id: DocumentId): Promise<TreeList | null>;
}

/** The key `occupantsAt` answers under. */
export function coordinatesKey(
  at: Pick<
    DocumentCoordinates,
    "owner" | "scheme" | "workId" | "rootThreadId" | "chatThreadId" | "path"
  >,
): string {
  return JSON.stringify([
    at.owner,
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
  segment: string;
};

/** One node a slot reaches, and how: `0` by its `~id`, `1` the plain child of the name, `2` a folder of the name. */
type SlotHit = { key: number; id: string; how: number };

/**
 * The node of one kind that the view shows at each slot (source, parent, segment), read as
 * `childAtSegment` in `@meridian/project-tree` reads it: a `~` suffix reaches the child whose id
 * begins with it, the lowest id if two do, and one that reaches none reads as its name; a name
 * reaches the child of that name with no suffix. At a `folder` level of a path, a folder of the
 * name answers when the plain twin is a document (the lowest id). One statement for any number of
 * slots: each is a `LATERAL` probe of the relation, which keeps a Work's union planned as index
 * probes (see the store page); only a segment with a suffix scans its parent's children.
 */
async function nodesAt(
  db: DrizzleDb,
  view: TreeView,
  kind: "document" | "folder",
  slots: readonly NodeSlot[],
  level?: "folder",
): Promise<SlotHit[]> {
  if (slots.length === 0) return [];
  const relation = kind === "document" ? visibleDocumentsSql(view) : visibleFoldersSql(view);
  const parentColumn = sql.raw(kind === "document" ? "r.folder_id" : "r.parent_id");
  const byName = level === "folder" ? sql`r.name = s.name` : sql`r.segment = s.name`;
  const probe = (rooted: boolean, byId: boolean): SQL | null => {
    const mine = slots.filter(
      (slot) =>
        (slot.parentId === null) === rooted &&
        (readSegment(slot.segment).suffix !== undefined) === byId,
    );
    if (mine.length === 0) return null;
    const values = sql.join(
      mine.map((slot) => {
        const { name, suffix } = readSegment(slot.segment);
        return rooted
          ? sql`(${slot.key}::int, ${slot.sourceId}::uuid, ${name}::text, ${suffix ?? ""}::text)`
          : sql`(${slot.key}::int, ${slot.sourceId}::uuid, ${name}::text, ${suffix ?? ""}::text, ${slot.parentId}::uuid)`;
      }),
      sql`, `,
    );
    const idMatch = sql`replace(r.id::text, '-', '') LIKE s.prefix || '%'`;
    const how = byId
      ? sql`CASE WHEN ${idMatch} THEN 0 WHEN r.segment = r.name THEN 1 ELSE 2 END`
      : sql`CASE WHEN r.segment = r.name THEN 1 ELSE 2 END`;
    return sql`SELECT s.key, n.id::text AS id, n.how
      FROM (VALUES ${values}) AS s(${sql.raw(rooted ? "key, source_id, name, prefix" : "key, source_id, name, prefix, parent_id")})
      CROSS JOIN LATERAL (
        SELECT r.id, ${how} AS how FROM ${relation} r
        WHERE r.context_source_id = s.source_id
          AND ${byId ? sql`(${idMatch} OR ${byName})` : byName}
          AND ${rooted ? sql`${parentColumn} IS NULL` : sql`${parentColumn} = s.parent_id`}
        ORDER BY how, r.id LIMIT 1
      ) n`;
  };
  const statements = [
    probe(true, false),
    probe(false, false),
    probe(true, true),
    probe(false, true),
  ].filter((each): each is SQL => each !== null);
  return [...(await db.execute<SlotHit>(sql.join(statements, sql` UNION ALL `)))];
}

/** Of a slot's document and folder hits, the ones it reaches best: an `~id` match over a name. */
function best(...kinds: SlotHit[][]): SlotHit[][] {
  const top = new Map<number, number>();
  for (const hit of kinds.flat()) top.set(hit.key, Math.min(top.get(hit.key) ?? hit.how, hit.how));
  return kinds.map((hits) => hits.filter((hit) => hit.how === top.get(hit.key)));
}

type PathOccupancy = {
  path: string;
  documents: DocumentId[];
  folders: FolderId[];
  /** The folder the path's directory reaches (null: the source root); empty when it reaches none. */
  parents: (FolderId | null)[];
  /** A segment reached its node by a fallback (a `~id` that reached none, a folder of the name): `path` is not how the tree spells it. */
  respelled: boolean;
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
      segment: row.segment,
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
   * The one meaning of "same path": the id of the node the view shows at each source-relative
   * path, walked one level at a time through the view's folders by segment (one statement per
   * depth for the whole batch, then one for the documents and one for the folders). A segment
   * reaches one node of each kind at most; of a document and a folder the lowest id answers.
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
        respelled: false,
      };
    });
    // A hit is as asked when a `~id` reached its node by id, or a name its plain child.
    const respelled = (segment: string, hits: readonly SlotHit[]) =>
      hits.some((hit) => hit.how !== (readSegment(segment).suffix === undefined ? 1 : 0));
    const depth = Math.max(0, ...walks.map((walk) => walk.dirs.length));
    for (let level = 0; level < depth; level += 1) {
      const asked = positions(
        walks.flatMap((walk, owner) =>
          level < walk.dirs.length
            ? walk.parents.map((parentId) => ({
                owner,
                sourceId: walk.sourceId,
                parentId,
                segment: walk.dirs[level] as string,
              }))
            : [],
        ),
      );
      const hits = await nodesAt(tx(), view, "folder", asked.slots, "folder");
      walks.forEach((walk, owner) => {
        if (level >= walk.dirs.length) return;
        const mine = asked.hitsFor(owner, hits);
        walk.parents = [...new Set(mine.map((hit) => hit.id))] as FolderId[];
        if (respelled(walk.dirs[level] as string, mine)) walk.respelled = true;
      });
    }
    const leaves = positions(
      walks.flatMap((walk, owner) =>
        walk.parents.map((parentId) => ({
          owner,
          sourceId: walk.sourceId,
          parentId,
          segment: walk.filename,
        })),
      ),
    );
    const [documentHits, folderHits] = best(
      ...(await Promise.all([
        nodesAt(tx(), view, "document", leaves.slots),
        nodesAt(tx(), view, "folder", leaves.slots),
      ])),
    ) as [SlotHit[], SlotHit[]];
    return walks.map((walk, owner) => ({
      path: walk.path,
      documents: leaves.idsFor(owner, documentHits) as DocumentId[],
      folders: leaves.idsFor(owner, folderHits) as FolderId[],
      parents: walk.parents,
      respelled:
        walk.respelled ||
        respelled(walk.filename, [
          ...leaves.hitsFor(owner, documentHits),
          ...leaves.hitsFor(owner, folderHits),
        ]),
    }));
  }

  async function resolvePath(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>> {
    const [found] = await pathOccupants(view, [at]);
    const ref = found && lowest(found.documents, found.folders);
    if (!found || !ref) return { kind: "not_found" };
    if (ref.kind === "document") {
      const [row] = await documentRows(view, (vd) => inArray(vd.id, [ref.id]));
      if (!row) return { kind: "not_found" };
      // Reached by a fallback: the path is the one the tree spells, not the one asked.
      const path = found.respelled
        ? chainPrefix(
            row.folderId === null
              ? []
              : ((await loadFolderChains(tx(), [row.folderId], view)).get(row.folderId) ?? []),
          ) + row.segment
        : found.path;
      return { kind: "found", node: { kind: "document", document: toDocument(row, path) } };
    }
    const [row] = await folderRows(view, (vf) => inArray(vf.id, [ref.id]));
    if (!row) return { kind: "not_found" };
    const path = found.respelled
      ? chainPrefix((await loadFolderChains(tx(), [row.id], view)).get(row.id) ?? []).slice(0, -1)
      : found.path;
    return { kind: "found", node: { kind: "folder", folder: { ...row, path } } };
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
      { key: 0, sourceId: at.contextSourceId, parentId: at.parentId, segment: at.filename },
    ];
    const [documentHits, folderHits] = best(
      ...(await Promise.all([
        nodesAt(tx(), view, "document", slot),
        nodesAt(tx(), view, "folder", slot),
      ])),
    ) as [SlotHit[], SlotHit[]];
    const ref = lowest(
      documentHits.map((hit) => hit.id as DocumentId),
      folderHits.map((hit) => hit.id as FolderId),
    );
    return ref ? { kind: "found", node: ref } : { kind: "not_found" };
  }

  async function findById(view: TreeView, id: DocumentId) {
    if (!isUuid(id)) return { kind: "not_found" } as const;
    const [row] = await documentRows(view, (vd) => inArray(vd.id, [id]));
    if (!row) return { kind: "not_found" } as const;
    const chains = await loadFolderChains(tx(), [row.folderId], view);
    const path =
      chainPrefix(row.folderId === null ? [] : (chains.get(row.folderId) ?? [])) + row.segment;
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
      segment: string;
      file_type: string;
      deleted: boolean;
      exists_only_in_draft: boolean;
      in_trash: boolean;
    }>(sql`
      SELECT n.id::text AS id, n.context_source_id::text AS context_source_id,
        n.parent_id::text AS parent_id, n.segment, n.file_type, n.deleted, n.exists_only_in_draft,
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
        segment: row.segment,
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
        at.owner,
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
          owner: at.owner,
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
        folders: chain,
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
      if (found.kind === "found" && found.node.kind === "document") return found;
    }
    // A link may leave off the extension: the one document under the reached folder that differs
    // only by it.
    const [occupancy] = await pathOccupants(view, [at]);
    const parent = occupancy?.parents[0];
    if (parent === undefined || !isUuid(at.contextSourceId)) return { kind: "not_found" };
    const siblings = await documentRows(view, (vd) =>
      and(
        eq(vd.contextSourceId, at.contextSourceId),
        parent === null ? isNull(vd.folderId) : eq(vd.folderId, parent),
      ),
    );
    const row = matchOmittedExtension(siblings, at.path.slice(slash + 1), (each) => each.segment);
    if (!row) return { kind: "not_found" };
    const document = await findById(view, row.id);
    return document.kind === "found"
      ? { kind: "found", node: { kind: "document", document: document.document } }
      : { kind: "not_found" };
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
    ownerOfDocument: (id) => ownerOfDocument(tx(), id),
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
    const identity = JSON.stringify([ask.sourceId, ask.parentId, ask.segment]);
    let key = keys.get(identity);
    if (key === undefined) {
      key = slots.length;
      keys.set(identity, key);
      slots.push({ key, sourceId: ask.sourceId, parentId: ask.parentId, segment: ask.segment });
    }
    owners.set(ask.owner, [...(owners.get(ask.owner) ?? []), key]);
  }
  return {
    slots,
    hitsFor<Hit extends { key: number }>(owner: number, hits: readonly Hit[]): Hit[] {
      const asked = new Set(owners.get(owner) ?? []);
      return hits.filter((hit) => asked.has(hit.key));
    },
    idsFor(owner: number, hits: readonly { key: number; id: string }[]): string[] {
      return [...new Set(this.hitsFor(owner, hits).map((hit) => hit.id))];
    },
  };
}

/** Of the document and the folder a segment reaches, the one with the lowest id. */
function lowest(documents: readonly DocumentId[], folders: readonly FolderId[]): NodeRef | null {
  const [document] = documents;
  const [folder] = folders;
  if (document && (!folder || document < folder)) return { kind: "document", id: document };
  return folder ? { kind: "folder", id: folder } : null;
}

/** The identity of a node a reader found. */
export function refOf(node: TreeNode): NodeRef {
  return node.kind === "document"
    ? { kind: "document", id: node.document.id }
    : { kind: "folder", id: node.folder.id };
}
