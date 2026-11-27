import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import {
  type ContextUriScheme,
  canonicalContextUri,
  isContextUriScheme,
  isProjectScopedScheme,
} from "@meridian/contracts/context-uri";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { contextSources, projects, works } from "@meridian/database/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { sourceAuthority } from "../adapters/context-file-entry.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownerFrom, ownerProjectIdSql } from "./source-owner.js";
import { LIVE_TREE, type TreeView } from "./tree-relations.js";

export type DocumentCoordinates = {
  owner: TreeList;
  userId: string;
  scheme: ContextUriScheme;
  workId: string | null;
  /** Lock coordinate: a Work-scoped source locks by its persisted Work row, No Work included. */
  lockWorkId: string | null;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
  path: string;
};

export type DocumentAddress = DocumentCoordinates & {
  documentId: DocumentId;
  contextSourceId: ContextSourceId;
  uri: string;
  deleted: boolean;
  image: boolean;
};

export function placedNodesSql(view: TreeView): SQL {
  const live = sql`SELECT t.id, t.kind, t.context_source_id, t.parent_id, t.name, t.segment, t.extension, t.stem,
      t.file_type, t.rank, t.location_version, t.trash_record IS NOT NULL AS deleted,
      false AS exists_only_in_draft
    FROM tree_nodes t`;
  if (view.kind === "live") return sql`(${live})`;
  const draft = sql`${view.draftId}`;
  return sql`(${live}
    WHERE NOT EXISTS (SELECT 1 FROM draft_tree_nodes x WHERE x.draft_id = ${draft} AND x.id = t.id)
    UNION ALL
    SELECT b.id, b.kind, b.context_source_id, b.parent_id, b.name, b.segment, b.extension,
      CASE WHEN b.extension <> '' THEN left(b.name, -(length(b.extension) + 1)) ELSE b.name END,
      b.file_type, b.rank, coalesce(lt.location_version, 0), b.deleted, b.exists_only_in_draft
    FROM draft_tree_nodes b LEFT JOIN tree_nodes lt ON lt.id = b.id
    WHERE b.draft_id = ${draft})`;
}

export type DocumentAddressSelection =
  | { ids: readonly string[] }
  | { names: readonly string[]; projectIds: readonly string[]; accountId?: string }
  | { sourceId: string; filename: string };

export async function loadDocumentAddresses(
  db: DrizzleDb,
  selection: DocumentAddressSelection,
  view: TreeView = LIVE_TREE,
): Promise<DocumentAddress[]> {
  const filter = selectionFilter(selection);
  if (!filter) return [];
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    project_id: string | null;
    account_id: string | null;
    user_id: string | null;
    scheme: string;
    work_id: string | null;
    work_handle: string | null;
    root_thread_id: string | null;
    chat_thread_id: string | null;
    root_thread_ref: string | null;
    is_no_work: boolean | null;
    path: string;
    context_source_id: string;
    deleted: boolean;
    file_type: string;
  }>(sql`
    WITH RECURSIVE candidates AS (
      SELECT d.id, d.segment, d.parent_id AS folder_id, d.context_source_id, d.file_type, d.deleted
      FROM ${placedNodesSql(view)} d WHERE d.kind = 'document' AND ${filter}
    ),
    up AS (
      SELECT c.id AS document_id, c.folder_id AS folder_id, ''::text AS path
      FROM candidates c
      UNION ALL
      SELECT u.document_id, f.parent_id, f.segment || '/' || u.path
      FROM up u CROSS JOIN LATERAL (
        SELECT p.parent_id, p.segment FROM ${placedNodesSql(view)} p WHERE p.id = u.folder_id OFFSET 0
      ) f
    )
    SELECT c.id::text AS id,
      ${ownerProjectIdSql("cs", "w")}::text AS project_id,
      cs.user_id::text AS account_id,
      COALESCE(cs.user_id, p.user_id)::text AS user_id,
      cs.slug AS scheme, cs.work_id::text AS work_id, w.handle AS work_handle,
      w.is_no_work AS is_no_work, cs.root_thread_id::text AS root_thread_id,
      cs.chat_thread_id::text AS chat_thread_id, root.ref AS root_thread_ref,
      up.path || c.segment AS path, c.context_source_id::text AS context_source_id,
      c.deleted OR cs.deleted_at IS NOT NULL OR w.deleted_at IS NOT NULL AS deleted,
      c.file_type
    FROM candidates c
    JOIN up ON up.document_id = c.id AND up.folder_id IS NULL
    JOIN context_sources cs ON cs.id = c.context_source_id
    LEFT JOIN works w ON w.id = cs.work_id
    LEFT JOIN threads root ON root.id = COALESCE(cs.root_thread_id, cs.chat_thread_id)
    LEFT JOIN projects p ON p.id = ${ownerProjectIdSql("cs", "w")}
  `);
  return rows.flatMap((row): DocumentAddress[] => {
    if (!row.user_id || !isContextUriScheme(row.scheme)) return [];
    const scheme = row.scheme;
    let uri: string;
    try {
      uri = canonicalContextUri(
        scheme,
        row.path,
        sourceAuthority(
          scheme,
          row.work_id,
          row.is_no_work ? null : row.work_handle,
          row.root_thread_ref,
          row.chat_thread_id !== null,
        ),
      );
    } catch {
      return [];
    }
    return [
      {
        documentId: row.id as DocumentId,
        contextSourceId: row.context_source_id as ContextSourceId,
        owner: ownerFrom({ projectId: row.project_id, userId: row.account_id }),
        userId: row.user_id,
        scheme,
        workId: row.work_id && !row.is_no_work ? row.work_id : null,
        lockWorkId: row.work_id,
        rootThreadId: row.root_thread_id,
        chatThreadId: row.chat_thread_id,
        path: row.path,
        uri,
        deleted: row.deleted,
        image: isImageFiletype(row.file_type),
      },
    ];
  });
}

/** A stored image's `file_type` is its filetype (`png`, `jpg`, `svg`), not the word `image`. */
function isImageFiletype(fileType: string): boolean {
  const disposition = classifyFiletype(fileType);
  return disposition.kind === "binary" && disposition.fileType === "image";
}

function selectionFilter(selection: DocumentAddressSelection): SQL | null {
  if ("ids" in selection) {
    const ids = selection.ids.filter(isUuid);
    return ids.length === 0 ? null : sql`d.id IN (${uuidList(ids)})`;
  }
  if ("names" in selection) {
    const projectIds = selection.projectIds.filter(isUuid);
    const accountId =
      selection.accountId && isUuid(selection.accountId) ? selection.accountId : null;
    if (selection.names.length === 0 || (projectIds.length === 0 && !accountId)) return null;
    const names = sql.join(
      selection.names.map((name) => sql`${name}`),
      sql`, `,
    );
    const owned = [
      ...(projectIds.length > 0
        ? [sql`${ownerProjectIdSql("cs", "w")} IN (${uuidList(projectIds)})`]
        : []),
      ...(accountId ? [sql`cs.user_id = ${accountId}::uuid`] : []),
    ];
    return sql`(d.name IN (${names}) OR d.stem IN (${names})) AND d.context_source_id IN (
      SELECT cs.id FROM context_sources cs LEFT JOIN works w ON w.id = cs.work_id
      WHERE ${sql.join(owned, sql` OR `)})`;
  }
  return sql`d.context_source_id = ${selection.sourceId}::uuid AND d.segment = ${selection.filename}`;
}

export async function presentSourceId(
  db: DrizzleDb,
  input: {
    scheme: string;
    workId: string | null;
    owner: TreeList;
    rootThreadId?: string | null;
    chatThreadId?: string | null;
  },
): Promise<ContextSourceId | null> {
  const workScoped = !isProjectScopedScheme(input.scheme as ContextUriScheme);
  const projectId = input.owner.kind === "project" ? input.owner.projectId : null;
  const [source] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(
      and(
        eq(contextSources.slug, input.scheme),
        isNull(contextSources.deletedAt),
        input.chatThreadId
          ? and(
              eq(contextSources.chatThreadId, input.chatThreadId),
              eq(projects.id, projectId ?? ""),
              isNull(projects.deletedAt),
            )
          : input.rootThreadId
            ? and(
                eq(contextSources.rootThreadId, input.rootThreadId),
                eq(projects.id, projectId ?? ""),
                isNull(projects.deletedAt),
              )
            : workScoped
              ? and(
                  projectId === null ? sql`false` : eq(works.projectId, projectId),
                  input.workId !== null ? eq(works.id, input.workId) : eq(works.isNoWork, true),
                )
              : input.owner.kind === "account"
                ? and(
                    eq(contextSources.scope, "account"),
                    eq(contextSources.userId, input.owner.userId as UserId),
                  )
                : and(
                    isNull(contextSources.workId),
                    isNull(projects.deletedAt),
                    eq(projects.id, input.owner.projectId as ProjectId),
                  ),
      ),
    )
    .limit(1);
  return source?.id ?? null;
}

export type FolderLink = {
  id: FolderId;
  parentId: FolderId | null;
  name: string;
  segment: string;
  deleted: boolean;
};

export async function loadFolderChains(
  db: DrizzleDb,
  folderIds: readonly (FolderId | null)[],
  view: TreeView = LIVE_TREE,
): Promise<ReadonlyMap<FolderId, readonly FolderLink[]>> {
  const ids = [...new Set(folderIds.filter((id): id is FolderId => id !== null && isUuid(id)))];
  const chains = new Map<FolderId, FolderLink[]>();
  if (ids.length === 0) return chains;
  const rows = await currentDrizzleDb(db).execute<{
    start_id: string;
    id: string;
    parent_id: string | null;
    name: string;
    segment: string;
    deleted: boolean;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT f.id AS start_id, f.id, f.parent_id, f.name, f.segment, f.deleted, 0 AS depth
      FROM ${placedNodesSql(view)} f WHERE f.kind = 'folder' AND f.id IN (${uuidList(ids)})
      UNION ALL
      SELECT c.start_id, f.id, f.parent_id, f.name, f.segment, f.deleted, c.depth + 1
      FROM chain c CROSS JOIN LATERAL (
        SELECT p.id, p.parent_id, p.name, p.segment, p.deleted
        FROM ${placedNodesSql(view)} p WHERE p.id = c.parent_id OFFSET 0
      ) f
    )
    SELECT start_id::text, id::text, parent_id::text, name, segment, deleted, depth FROM chain
    ORDER BY start_id, depth`);
  for (const row of rows) {
    const chain = chains.get(row.start_id as FolderId) ?? [];
    chain.push({
      id: row.id as FolderId,
      parentId: row.parent_id as FolderId | null,
      name: row.name,
      segment: row.segment,
      deleted: row.deleted,
    });
    chains.set(row.start_id as FolderId, chain);
  }
  return chains;
}

export type FolderAddress = Omit<NodeAddress, "documentId" | "image"> & {
  folderId: FolderId;
  deleted: boolean;
};

export async function loadFolderAddresses(
  db: DrizzleDb,
  folderIds: readonly string[],
  view: TreeView = LIVE_TREE,
): Promise<FolderAddress[]> {
  const ids = [...new Set(folderIds.filter(isUuid))];
  if (ids.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    parent_id: string | null;
    context_source_id: string;
    segment: string;
    deleted: boolean;
  }>(sql`
    SELECT n.id::text AS id, n.parent_id::text AS parent_id,
      n.context_source_id::text AS context_source_id, n.segment, n.deleted
    FROM ${placedNodesSql(view)} n WHERE n.kind = 'folder' AND n.id IN (${uuidList(ids)})`);
  const chains = await loadFolderChains(
    db,
    rows.map((row) => row.parent_id as FolderId | null),
    view,
  );
  const spelled = await spellNodeAddresses(
    db,
    rows.map((row) => ({
      documentId: row.id as DocumentId,
      contextSourceId: row.context_source_id as ContextSourceId,
      folderId: row.parent_id as FolderId | null,
      segment: row.segment,
      fileType: "folder",
    })),
    chains,
  );
  return rows.flatMap((row, index): FolderAddress[] => {
    const address = spelled[index];
    if (!address) return [];
    return [
      {
        ...address,
        folderId: row.id as FolderId,
        path: `${address.path}/`,
        uri: `${address.uri}/`,
        deleted: row.deleted,
      },
    ];
  });
}

export function chainPrefix(chain: readonly FolderLink[]): string {
  return [...chain]
    .reverse()
    .map((folder) => `${folder.segment}/`)
    .join("");
}

export type NodeLocation = {
  documentId: DocumentId;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  segment: string;
  fileType: string;
};

export type NodeAddress = {
  documentId: DocumentId;
  owner: TreeList;
  userId: UserId;
  scheme: ContextUriScheme;
  workId: WorkId | null;
  workHandle: string | null;
  rootThreadId: string | null;
  chatThreadId: string | null;
  contextSourceId: ContextSourceId;
  path: string;
  uri: string;
  image: boolean;
};

export async function spellNodeAddresses(
  db: DrizzleDb,
  locations: readonly NodeLocation[],
  chains?: ReadonlyMap<FolderId, readonly FolderLink[]>,
): Promise<(NodeAddress | null)[]> {
  if (locations.length === 0) return [];
  const folderChains =
    chains ??
    (await loadFolderChains(
      db,
      locations.map((location) => location.folderId),
    ));
  const sourceIds = [...new Set(locations.map((location) => location.contextSourceId))].filter(
    isUuid,
  );
  const sources = new Map(
    (sourceIds.length === 0
      ? []
      : await currentDrizzleDb(db).execute<{
          id: string;
          project_id: string | null;
          account_id: string | null;
          user_id: string | null;
          scheme: string;
          work_id: string | null;
          work_handle: string | null;
          is_no_work: boolean | null;
          root_thread_id: string | null;
          chat_thread_id: string | null;
          root_thread_ref: string | null;
        }>(sql`
          SELECT cs.id::text AS id, ${ownerProjectIdSql("cs", "w")}::text AS project_id,
            cs.user_id::text AS account_id, COALESCE(cs.user_id, p.user_id)::text AS user_id,
            cs.slug AS scheme, cs.work_id::text AS work_id,
            w.handle AS work_handle, w.is_no_work, cs.root_thread_id::text AS root_thread_id,
            cs.chat_thread_id::text AS chat_thread_id, root.ref AS root_thread_ref
          FROM context_sources cs
          LEFT JOIN works w ON w.id = cs.work_id
          LEFT JOIN threads root ON root.id = COALESCE(cs.root_thread_id, cs.chat_thread_id)
          LEFT JOIN projects p ON p.id = ${ownerProjectIdSql("cs", "w")}
          WHERE cs.id IN (${uuidList(sourceIds)})`)
    ).map((row) => [row.id, row]),
  );
  return locations.map((location) => {
    const source = sources.get(location.contextSourceId);
    if (!source?.user_id || !isContextUriScheme(source.scheme)) return null;
    const chain = location.folderId === null ? [] : folderChains.get(location.folderId);
    if (!chain || chain.at(-1)?.parentId) return null;
    const path = chainPrefix(chain) + location.segment;
    const scheme = source.scheme;
    const workHandle = source.is_no_work ? null : source.work_handle;
    let uri: string;
    try {
      uri = canonicalContextUri(
        scheme,
        path,
        sourceAuthority(
          scheme,
          source.work_id,
          workHandle,
          source.root_thread_ref,
          source.chat_thread_id !== null,
        ),
      );
    } catch {
      return null;
    }
    return {
      documentId: location.documentId,
      owner: ownerFrom({ projectId: source.project_id, userId: source.account_id }),
      userId: source.user_id as UserId,
      scheme,
      workId: source.work_id && !source.is_no_work ? (source.work_id as WorkId) : null,
      workHandle,
      rootThreadId: source.root_thread_id,
      chatThreadId: source.chat_thread_id,
      contextSourceId: location.contextSourceId,
      path,
      uri,
      image: isImageFiletype(location.fileType),
    };
  });
}

export type DocumentPlacement = { contextSourceId: ContextSourceId; fileType: string };

export async function loadDocumentPlacements(
  db: DrizzleDb,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, DocumentPlacement>> {
  const ids = [...new Set(documentIds)].filter(isUuid);
  if (ids.length === 0) return new Map();
  const list = uuidList(ids);
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    source_id: string;
    file_type: string;
  }>(sql`
    SELECT DISTINCT ON (p.id) p.id::text AS id, p.context_source_id::text AS source_id, p.file_type
    FROM (
      SELECT id, context_source_id, file_type, 0 AS ord FROM tree_nodes WHERE id IN (${list})
      UNION ALL
      SELECT id, context_source_id, file_type, 1 FROM draft_tree_nodes WHERE id IN (${list})
    ) p
    WHERE p.file_type IS NOT NULL
    ORDER BY p.id, p.ord`);
  return new Map(
    rows.map((row) => [
      row.id as DocumentId,
      { contextSourceId: row.source_id as ContextSourceId, fileType: row.file_type },
    ]),
  );
}

export async function loadDocumentPlacement(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<DocumentPlacement | null> {
  return (await loadDocumentPlacements(db, [documentId])).get(documentId) ?? null;
}

export async function ownerOfDocument(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<TreeList | null> {
  if (!isUuid(documentId)) return null;
  const [row] = await currentDrizzleDb(db).execute<{
    project_id: string | null;
    user_id: string | null;
  }>(sql`SELECT project_id::text, user_id::text FROM documents WHERE id = ${documentId}::uuid`);
  return row ? ownerFrom({ projectId: row.project_id, userId: row.user_id }) : null;
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
