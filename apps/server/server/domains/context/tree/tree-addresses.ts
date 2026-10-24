/**
 * Identity rows and their spelled addresses, hidden and deleted included: the tree
 * owner's address loader. Answers where a row is, never whether a view shows it;
 * `tree-view.ts` decides visibility and uses these to spell what it decided.
 *
 * The deleted-ancestor rule: a document under a deleted folder keeps the address its
 * chain spells and reads as deleted there, exactly like a deleted row, a deleted source,
 * or a deleted Work.
 */
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
import { contextSources, projects, works } from "@meridian/database/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { catalogSourceAuthority } from "../adapters/catalog-file-mapper.js";
import { renderFilename } from "../context/paths.js";
import { documentHiddenSql } from "./tree-view-sql.js";

/** A decoded canonical address resolved to storage coordinates. */
export type DocumentCoordinates = {
  /** The project storing the source: the personal project for `user://`. */
  projectId: ProjectId;
  /** That project's owner; keys the `user://` namespace. */
  userId: string;
  scheme: ContextUriScheme;
  /** Address coordinate: null for project-scoped schemes and for No Work. */
  workId: string | null;
  /** Lock coordinate: a Work-scoped source locks by its persisted Work row, No Work included. */
  lockWorkId: string | null;
  /** A lineage Scratch's first chat; null or absent for every other source. */
  rootThreadId?: string | null;
  /** The chat whose uploads hold the document; null or absent for every other source. */
  chatThreadId?: string | null;
  /** Path inside the source, with extension. */
  path: string;
};

/** Where a document's row is, deleted and hidden rows included (see the deleted-ancestor rule). */
export type DocumentAddress = DocumentCoordinates & {
  documentId: DocumentId;
  /** Decoded canonical URI. */
  uri: string;
  deleted: boolean;
  /** A branch's new document, in no live view; its address is its row's, not a branch overlay. */
  hidden: boolean;
  image: boolean;
};

/** Which content documents to spell. */
export type DocumentAddressSelection =
  | { ids: readonly string[] }
  /** Every document whose stored name (without extension) is one of these, in these projects. */
  | { names: readonly string[]; projectIds: readonly string[] }
  /** Every document in this source whose rendered filename is exactly this. */
  | { sourceId: string; filename: string };

/**
 * Content documents and their canonical addresses at their rows' locations: each folder
 * chain walked up to its source root. A row whose path cannot be spelled canonically is
 * dropped.
 */
export async function loadDocumentAddresses(
  db: DrizzleDb,
  selection: DocumentAddressSelection,
): Promise<DocumentAddress[]> {
  const filter = selectionFilter(selection);
  if (!filter) return [];
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    project_id: string | null;
    user_id: string | null;
    scheme: string;
    work_id: string | null;
    work_handle: string | null;
    root_thread_id: string | null;
    chat_thread_id: string | null;
    root_thread_ref: string | null;
    is_no_work: boolean | null;
    path: string;
    deleted: boolean;
    hidden: boolean;
    image: boolean;
  }>(sql`
    WITH RECURSIVE candidates AS (
      SELECT d.id, d.name, d.extension, d.folder_id, d.context_source_id, d.file_type,
        d.deleted_at IS NOT NULL AS deleted, ${documentHiddenSql("d")} AS hidden
      FROM documents d WHERE ${filter}
    ),
    up AS (
      SELECT c.id AS document_id, c.folder_id AS folder_id, ''::text AS path, false AS deleted
      FROM candidates c
      UNION ALL
      SELECT u.document_id, f.parent_id, f.name || '/' || u.path,
        u.deleted OR f.deleted_at IS NOT NULL
      FROM up u JOIN folders f ON f.id = u.folder_id
    )
    SELECT c.id::text AS id,
      COALESCE(cs.project_id, w.project_id)::text AS project_id,
      p.user_id::text AS user_id,
      cs.slug AS scheme, cs.work_id::text AS work_id, w.handle AS work_handle,
      w.is_no_work AS is_no_work, cs.root_thread_id::text AS root_thread_id,
      cs.chat_thread_id::text AS chat_thread_id, root.ref AS root_thread_ref,
      up.path || c.name || CASE WHEN c.extension = '' THEN '' ELSE '.' || c.extension END AS path,
      c.deleted OR up.deleted OR cs.deleted_at IS NOT NULL OR w.deleted_at IS NOT NULL
        AS deleted,
      c.hidden,
      c.file_type = 'image' AS image
    FROM candidates c
    JOIN up ON up.document_id = c.id AND up.folder_id IS NULL
    JOIN context_sources cs ON cs.id = c.context_source_id
    LEFT JOIN works w ON w.id = cs.work_id
    LEFT JOIN threads root ON root.id = COALESCE(cs.root_thread_id, cs.chat_thread_id)
    LEFT JOIN projects p ON p.id = COALESCE(cs.project_id, w.project_id)
  `);
  return rows.flatMap((row): DocumentAddress[] => {
    if (!row.project_id || !row.user_id || !isContextUriScheme(row.scheme)) return [];
    const scheme = row.scheme;
    let uri: string;
    try {
      uri = canonicalContextUri(
        scheme,
        row.path,
        catalogSourceAuthority(
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
        projectId: row.project_id as ProjectId,
        userId: row.user_id,
        scheme,
        workId: row.work_id && !row.is_no_work ? row.work_id : null,
        lockWorkId: row.work_id,
        rootThreadId: row.root_thread_id,
        chatThreadId: row.chat_thread_id,
        path: row.path,
        uri,
        deleted: row.deleted,
        hidden: row.hidden,
        image: row.image,
      },
    ];
  });
}

function selectionFilter(selection: DocumentAddressSelection): SQL | null {
  if ("ids" in selection) {
    const ids = selection.ids.filter(isUuid);
    return ids.length === 0 ? null : sql`d.id IN (${uuidList(ids)})`;
  }
  if ("names" in selection) {
    const projectIds = selection.projectIds.filter(isUuid);
    if (selection.names.length === 0 || projectIds.length === 0) return null;
    return sql`d.name IN (${sql.join(
      selection.names.map((name) => sql`${name}`),
      sql`, `,
    )}) AND d.context_source_id IN (
      SELECT cs.id FROM context_sources cs LEFT JOIN works w ON w.id = cs.work_id
      WHERE COALESCE(cs.project_id, w.project_id) IN (${uuidList(projectIds)}))`;
  }
  return sql`d.context_source_id = ${selection.sourceId}::uuid
    AND d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END
      = ${selection.filename}`;
}

/**
 * The live source a scheme names: a project-scoped one in its project (or the owner's
 * personal project), a lineage Scratch by its first chat, a Work-scoped one in the named Work
 * or No Work. Liveness facts (live
 * source, live project, live work) are the same ones recent-documents' visibleIdentity
 * filters on and project-context-availability explains as a reason.
 */
export async function presentSourceId(
  db: DrizzleDb,
  input: {
    scheme: string;
    workId: string | null;
    project: { id: string } | { personalOf: string };
    rootThreadId?: string | null;
    chatThreadId?: string | null;
  },
): Promise<ContextSourceId | null> {
  const workScoped = !isProjectScopedScheme(input.scheme as ContextUriScheme);
  const projectId = "id" in input.project ? input.project.id : null;
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
                  isNull(works.deletedAt),
                  input.workId !== null ? eq(works.id, input.workId) : eq(works.isNoWork, true),
                )
              : and(
                  isNull(contextSources.workId),
                  isNull(projects.deletedAt),
                  "personalOf" in input.project
                    ? and(
                        eq(projects.userId, input.project.personalOf),
                        eq(projects.isPersonal, true),
                      )
                    : eq(projects.id, input.project.id),
                ),
      ),
    )
    .limit(1);
  return source?.id ?? null;
}

/** One folder of a chain: walked by id, so hidden and deleted folders spell too. */
export type FolderLink = {
  id: FolderId;
  parentId: FolderId | null;
  name: string;
  deleted: boolean;
};

/** Each folder and its ancestors, nearest first (the folder itself first). */
export async function loadFolderChains(
  db: DrizzleDb,
  folderIds: readonly (FolderId | null)[],
): Promise<ReadonlyMap<FolderId, readonly FolderLink[]>> {
  const ids = [...new Set(folderIds.filter((id): id is FolderId => id !== null && isUuid(id)))];
  const chains = new Map<FolderId, FolderLink[]>();
  if (ids.length === 0) return chains;
  const rows = await currentDrizzleDb(db).execute<{
    start_id: string;
    id: string;
    parent_id: string | null;
    name: string;
    deleted: boolean;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT f.id AS start_id, f.id, f.parent_id, f.name, f.deleted_at IS NOT NULL AS deleted,
        0 AS depth
      FROM folders f WHERE f.id IN (${uuidList(ids)})
      UNION ALL
      SELECT c.start_id, f.id, f.parent_id, f.name, f.deleted_at IS NOT NULL, c.depth + 1
      FROM chain c JOIN folders f ON f.id = c.parent_id
    )
    SELECT start_id::text, id::text, parent_id::text, name, deleted, depth FROM chain
    ORDER BY start_id, depth`);
  for (const row of rows) {
    const chain = chains.get(row.start_id as FolderId) ?? [];
    chain.push({
      id: row.id as FolderId,
      parentId: row.parent_id as FolderId | null,
      name: row.name,
      deleted: row.deleted,
    });
    chains.set(row.start_id as FolderId, chain);
  }
  return chains;
}

/** Source-relative path of a folder chain (nearest first), with a trailing slash unless empty. */
export function chainPrefix(chain: readonly FolderLink[]): string {
  return [...chain]
    .reverse()
    .map((folder) => `${folder.name}/`)
    .join("");
}

/** A node's location in some view: the row's, or a branch's. */
export type NodeLocation = {
  documentId: DocumentId;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  name: string;
  extension: string;
  fileType: string;
};

/** Where a node is, spelled as a canonical address. */
export type NodeAddress = {
  documentId: DocumentId;
  projectId: ProjectId;
  userId: UserId;
  scheme: ContextUriScheme;
  workId: WorkId | null;
  workHandle: string | null;
  /** A lineage Scratch's first chat; null for every other source. */
  rootThreadId: string | null;
  /** The chat whose uploads these are; null for every other source. */
  chatThreadId: string | null;
  contextSourceId: ContextSourceId;
  path: string;
  uri: string;
  image: boolean;
};

/**
 * Spell each location as an address, in input order; null when a folder in its chain is
 * missing, or its source or scheme can't be spelled canonically.
 */
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
          user_id: string | null;
          scheme: string;
          work_id: string | null;
          work_handle: string | null;
          is_no_work: boolean | null;
          root_thread_id: string | null;
          chat_thread_id: string | null;
          root_thread_ref: string | null;
        }>(sql`
          SELECT cs.id::text AS id, COALESCE(cs.project_id, w.project_id)::text AS project_id,
            p.user_id::text AS user_id, cs.slug AS scheme, cs.work_id::text AS work_id,
            w.handle AS work_handle, w.is_no_work, cs.root_thread_id::text AS root_thread_id,
            cs.chat_thread_id::text AS chat_thread_id, root.ref AS root_thread_ref
          FROM context_sources cs
          LEFT JOIN works w ON w.id = cs.work_id
          LEFT JOIN threads root ON root.id = COALESCE(cs.root_thread_id, cs.chat_thread_id)
          LEFT JOIN projects p ON p.id = COALESCE(cs.project_id, w.project_id)
          WHERE cs.id IN (${uuidList(sourceIds)})`)
    ).map((row) => [row.id, row]),
  );
  return locations.map((location) => {
    const source = sources.get(location.contextSourceId);
    if (!source?.project_id || !source.user_id || !isContextUriScheme(source.scheme)) return null;
    const chain = location.folderId === null ? [] : folderChains.get(location.folderId);
    if (!chain || chain.at(-1)?.parentId) return null;
    const path = chainPrefix(chain) + renderFilename(location.name, location.extension);
    const scheme = source.scheme;
    const workHandle = source.is_no_work ? null : source.work_handle;
    let uri: string;
    try {
      uri = canonicalContextUri(
        scheme,
        path,
        catalogSourceAuthority(
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
      projectId: source.project_id as ProjectId,
      userId: source.user_id as UserId,
      scheme,
      workId: source.work_id && !source.is_no_work ? (source.work_id as WorkId) : null,
      workHandle,
      rootThreadId: source.root_thread_id,
      chatThreadId: source.chat_thread_id,
      contextSourceId: location.contextSourceId,
      path,
      uri,
      image: location.fileType === "image",
    };
  });
}

/** The project storing a document's source (a Work-scoped source through its Work). */
export async function projectOfDocument(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<ProjectId | null> {
  if (!isUuid(documentId)) return null;
  const [row] = await currentDrizzleDb(db).execute<{ project_id: string | null }>(sql`
    SELECT COALESCE(cs.project_id, w.project_id)::text AS project_id
    FROM documents d
    JOIN context_sources cs ON cs.id = d.context_source_id
    LEFT JOIN works w ON w.id = cs.work_id
    WHERE d.id = ${documentId}::uuid`);
  return (row?.project_id ?? null) as ProjectId | null;
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
