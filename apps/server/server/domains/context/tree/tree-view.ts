import {
  type ContextSourceId,
  type DocumentId,
  type FolderId,
  matchOmittedExtension,
} from "@meridian/contracts";
import { addressCandidates, readSegment } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { and, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
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
  segment: string;
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

export type PathQuery = { contextSourceId: ContextSourceId; path: string };

export type PathResolution<N> = { kind: "found"; node: N } | { kind: "not_found" };

export type TreeNode =
  | { kind: "document"; document: VisibleDocument }
  | { kind: "folder"; folder: VisibleFolder };

export type IdentityStatus =
  | { kind: "visible"; address: NodeAddress; existsOnlyInDraft: boolean }
  | { kind: "deleted"; documentId: DocumentId; lastAddress: NodeAddress | null }
  | { kind: "gone"; documentId: DocumentId };

export type DocumentLineage = {
  status: "visible" | "deleted";
  inTrash: boolean;
  contextSourceId: ContextSourceId;
  folders: readonly FolderLink[];
};

export interface TreeReader {
  resolvePath(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  resolveAddress(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  resolveDocumentAddress(view: TreeView, at: PathQuery): Promise<PathResolution<TreeNode>>;
  resolveDocumentAddresses(
    view: TreeView,
    queries: readonly PathQuery[],
  ): Promise<PathResolution<TreeNode>[]>;
  folderIdsAt(view: TreeView, queries: readonly PathQuery[]): Promise<(FolderId | null)[]>;
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
  occupantsAt(
    view: TreeView,
    addresses: readonly DocumentCoordinates[],
  ): Promise<ReadonlyMap<string, DocumentId[]>>;
  lineages(
    view: TreeView,
    ids: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentLineage>>;
  ownerOfDocument(id: DocumentId): Promise<TreeList | null>;
}

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

type SlotHit = { key: number; id: string; how: number };

/**
 * The node of one kind that the view shows at each slot (source, parent, segment), read as
 * `childAtSegment` in `@meridian/contracts/protocol` reads it: a `~` suffix reaches the child whose id
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

function best(...kinds: SlotHit[][]): SlotHit[][] {
  const top = new Map<number, number>();
  for (const hit of kinds.flat()) top.set(hit.key, Math.min(top.get(hit.key) ?? hit.how, hit.how));
  return kinds.map((hits) => hits.filter((hit) => hit.how === top.get(hit.key)));
}

type FolderWalk = {
  sourceId: ContextSourceId;
  dirs: string[];
  filename: string;
  parents: (FolderId | null)[];
  respelled: boolean;
};

const isRespelled = (segment: string, hits: readonly SlotHit[]) =>
  hits.some((hit) => hit.how !== (readSegment(segment).suffix === undefined ? 1 : 0));

type PathOccupancy = {
  path: string;
  documents: DocumentId[];
  folders: FolderId[];
  parents: (FolderId | null)[];
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

  async function walkFolders(view: TreeView, walks: FolderWalk[]) {
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
        if (isRespelled(walk.dirs[level] as string, mine)) walk.respelled = true;
      });
    }
  }

  const folderWalk = (query: PathQuery, dirs: string[], filename: string): FolderWalk => ({
    sourceId: query.contextSourceId,
    dirs,
    filename,
    parents: isUuid(query.contextSourceId) ? [null] : [],
    respelled: false,
  });

  async function pathOccupants(
    view: TreeView,
    queries: readonly PathQuery[],
  ): Promise<PathOccupancy[]> {
    const walks = queries.map((query) => {
      const segments = query.path.split("/").filter(Boolean);
      const filename = segments.pop();
      const walk = folderWalk(query, segments, filename ?? "");
      if (filename === undefined) walk.parents = [];
      return {
        ...walk,
        path: [...segments, ...(filename === undefined ? [] : [filename])].join("/"),
      };
    });
    await walkFolders(view, walks);
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
        isRespelled(walk.filename, [
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

  async function resolveDocumentAddresses(
    view: TreeView,
    queries: readonly PathQuery[],
  ): Promise<PathResolution<TreeNode>[]> {
    const spellings = queries.map((at) => {
      const slash = at.path.lastIndexOf("/");
      return addressCandidates(at.path.slice(slash + 1)).map((leaf) => ({
        ...at,
        path: at.path.slice(0, slash + 1) + leaf,
      }));
    });
    const occupancies = await pathOccupants(view, spellings.flat());
    let next = 0;
    const walked = queries.map((at, index) => {
      const mine = occupancies.slice(next, next + (spellings[index]?.length ?? 0));
      next += mine.length;
      for (const occupancy of mine) {
        const ref = lowest(occupancy.documents, occupancy.folders);
        if (ref?.kind === "document")
          return { at, hit: { id: ref.id, occupancy }, parent: undefined };
      }
      return { at, hit: null, parent: mine[0]?.parents[0] };
    });
    const hitRows = await documentRows(view, (vd) =>
      inArray(
        vd.id,
        walked.flatMap(({ hit }) => (hit ? [hit.id] : [])),
      ),
    );
    const rowOf = new Map(hitRows.map((row) => [row.id, row]));
    const misses = walked.filter(
      ({ hit, parent, at }) =>
        (!hit || !rowOf.has(hit.id)) && parent !== undefined && isUuid(at.contextSourceId),
    );
    const siblings =
      misses.length === 0
        ? []
        : await documentRows(view, (vd) =>
            and(
              inArray(vd.contextSourceId, [...new Set(misses.map(({ at }) => at.contextSourceId))]),
              or(
                inArray(vd.folderId, [
                  ...new Set(misses.flatMap(({ parent }) => (parent ? [parent] : []))),
                ]),
                misses.some(({ parent }) => parent === null) ? isNull(vd.folderId) : undefined,
              ),
            ),
          );
    const reached = walked.map(({ at, hit, parent }) => {
      const row = hit && rowOf.get(hit.id);
      if (row && hit) return { row, path: hit.occupancy.respelled ? null : hit.occupancy.path };
      if (parent === undefined || !isUuid(at.contextSourceId)) return null;
      const slash = at.path.lastIndexOf("/");
      const loose = matchOmittedExtension(
        siblings.filter(
          (each) => each.contextSourceId === at.contextSourceId && each.folderId === parent,
        ),
        at.path.slice(slash + 1),
        (each) => each.segment,
      );
      return loose ? { row: loose, path: null } : null;
    });
    const chains = await loadFolderChains(
      tx(),
      reached.flatMap((each) => (each && each.path === null ? [each.row.folderId] : [])),
      view,
    );
    return reached.map((each): PathResolution<TreeNode> => {
      if (!each) return { kind: "not_found" };
      const { row } = each;
      const path =
        each.path ??
        chainPrefix(row.folderId === null ? [] : (chains.get(row.folderId) ?? [])) + row.segment;
      return { kind: "found", node: { kind: "document", document: toDocument(row, path) } };
    });
  }

  async function resolveDocumentAddress(
    view: TreeView,
    at: PathQuery,
  ): Promise<PathResolution<TreeNode>> {
    return (await resolveDocumentAddresses(view, [at]))[0] ?? { kind: "not_found" };
  }

  async function folderIdsAt(view: TreeView, queries: readonly PathQuery[]) {
    const walks = queries.map((query) =>
      folderWalk(query, query.path.split("/").filter(Boolean), ""),
    );
    await walkFolders(view, walks);
    return walks.map((walk) => walk.parents[0] ?? null);
  }

  return {
    resolvePath,
    resolveAddress,
    resolveDocumentAddress,
    resolveDocumentAddresses,
    folderIdsAt,
    childAt,
    findById,
    findFolderById,
    identityStatus,
    occupantsAt,
    lineages,
    ownerOfDocument: (id) => ownerOfDocument(tx(), id),
  };
}

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

function lowest(documents: readonly DocumentId[], folders: readonly FolderId[]): NodeRef | null {
  const [document] = documents;
  const [folder] = folders;
  if (document && (!folder || document < folder)) return { kind: "document", id: document };
  return folder ? { kind: "folder", id: folder } : null;
}

export function refOf(node: TreeNode): NodeRef {
  return node.kind === "document"
    ? { kind: "document", id: node.document.id }
    : { kind: "folder", id: node.folder.id };
}
