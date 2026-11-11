/**
 * Work/branch view as live rows left-joined to tree_branch_nodes, same columns as
 * visibleDocuments / visibleFolders (tree-view-sql.ts lines 30–61).
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";

const documentTail = sql`
  ''::text AS extension,
  'markdown'::text AS file_type,
  NULL::text AS storage_url,
  NULL::text AS mime_type,
  NULL::bigint AS size_bytes,
  false AS has_preview,
  '{}'::jsonb AS metadata,
  false AS provisional_name`;

/** Live visible documents: not the tree Y.Doc, not hidden, not deleted. */
export function liveDocumentsSql(treeDocId: string) {
  return sql`(
    SELECT d.id, d.context_source_id, d.folder_id, d.name, d.extension, d.file_type,
      d.storage_url, d.mime_type, d.size_bytes, d.has_preview, d.metadata, d.provisional_name,
      d.rank, d.location_version, d.hidden, d.created_at, d.updated_at
    FROM documents d
    WHERE d.deleted_at IS NULL AND NOT d.hidden AND d.id <> ${treeDocId}::uuid
  )`;
}

export function liveFoldersSql() {
  return sql`(
    SELECT f.id, f.context_source_id, f.parent_id, f.name, f.description, f.rank,
      f.hidden, f.location_version, f.created_at, f.updated_at
    FROM folders f
    WHERE f.deleted_at IS NULL AND NOT f.hidden
  )`;
}

/**
 * Branch documents: live left-joined to overlay, union overlay-only rows.
 * Overlay.deleted hides a live row; overlay name/parent/rank replace live.
 */
export function branchDocumentsSql(branchId: string, treeDocId: string) {
  return sql`(
    SELECT
      d.id,
      COALESCE(b.context_source_id, d.context_source_id) AS context_source_id,
      CASE WHEN b.node_id IS NOT NULL THEN b.parent_id ELSE d.folder_id END AS folder_id,
      COALESCE(b.name, d.name) AS name,
      d.extension, d.file_type, d.storage_url, d.mime_type, d.size_bytes, d.has_preview,
      d.metadata, d.provisional_name,
      COALESCE(b.rank, d.rank) AS rank,
      d.location_version, d.hidden, d.created_at, d.updated_at
    FROM documents d
    LEFT JOIN tree_branch_nodes b ON b.branch_id = ${branchId} AND b.node_id = d.id AND b.kind = 'document'
    WHERE d.id <> ${treeDocId}::uuid AND NOT d.hidden
      AND (
        (b.node_id IS NULL AND d.deleted_at IS NULL)
        OR (b.node_id IS NOT NULL AND NOT b.deleted AND NOT b.exists_only_in_draft)
      )
    UNION ALL
    SELECT
      b.node_id AS id,
      b.context_source_id,
      b.parent_id AS folder_id,
      b.name,
      ${documentTail},
      b.rank,
      0::bigint AS location_version,
      false AS hidden,
      now() AS created_at,
      now() AS updated_at
    FROM tree_branch_nodes b
    WHERE b.branch_id = ${branchId} AND b.kind = 'document' AND b.exists_only_in_draft AND NOT b.deleted
  )`;
}

export function branchFoldersSql(branchId: string) {
  return sql`(
    SELECT
      f.id,
      COALESCE(b.context_source_id, f.context_source_id) AS context_source_id,
      CASE WHEN b.node_id IS NOT NULL THEN b.parent_id ELSE f.parent_id END AS parent_id,
      COALESCE(b.name, f.name) AS name,
      f.description,
      COALESCE(b.rank, f.rank) AS rank,
      f.hidden, f.location_version, f.created_at, f.updated_at
    FROM folders f
    LEFT JOIN tree_branch_nodes b ON b.branch_id = ${branchId} AND b.node_id = f.id AND b.kind = 'folder'
    WHERE NOT f.hidden
      AND (
        (b.node_id IS NULL AND f.deleted_at IS NULL)
        OR (b.node_id IS NOT NULL AND NOT b.deleted AND NOT b.exists_only_in_draft)
      )
    UNION ALL
    SELECT
      b.node_id AS id,
      b.context_source_id,
      b.parent_id,
      b.name,
      NULL::text AS description,
      b.rank,
      false AS hidden,
      0::bigint AS location_version,
      now() AS created_at,
      now() AS updated_at
    FROM tree_branch_nodes b
    WHERE b.branch_id = ${branchId} AND b.kind = 'folder' AND b.exists_only_in_draft AND NOT b.deleted
  )`;
}

export type VisibleNode = {
  id: string;
  parent: string | null;
  name: string;
  rank: string | null;
  contextSourceId: string;
};

export async function listVisible(
  db: Database,
  kind: "document" | "folder",
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  sourceId?: string,
): Promise<VisibleNode[]> {
  const tx = currentDrizzleDb(db);
  const rel =
    kind === "document"
      ? view.kind === "live"
        ? liveDocumentsSql(treeDocId)
        : branchDocumentsSql(view.branchId, treeDocId)
      : view.kind === "live"
        ? liveFoldersSql()
        : branchFoldersSql(view.branchId);
  const parentCol = kind === "document" ? sql`folder_id` : sql`parent_id`;
  const sourceFilter = sourceId ? sql`WHERE v.context_source_id = ${sourceId}::uuid` : sql``;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, ${parentCol}::text AS parent, name, rank, context_source_id::text AS source
    FROM ${rel} v
    ${sourceFilter}
  `)) as unknown as Array<{
    id: string;
    parent: string | null;
    name: string;
    rank: string | null;
    source: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    parent: row.parent,
    name: row.name,
    rank: row.rank,
    contextSourceId: row.source,
  }));
}

/** Resolve a path of display names to a document id (recursive folder walk). */
export async function resolvePathSql(
  db: Database,
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  sourceId: string,
  parts: string[],
): Promise<string | null> {
  if (parts.length === 0) return null;
  const tx = currentDrizzleDb(db);
  const folders =
    view.kind === "live" ? liveFoldersSql() : branchFoldersSql(view.branchId);
  const docs =
    view.kind === "live"
      ? liveDocumentsSql(treeDocId)
      : branchDocumentsSql(view.branchId, treeDocId);
  const file = parts[parts.length - 1]!;
  const dirs = parts.slice(0, -1);
  const rows = (await tx.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT f.id, f.name, f.parent_id, 1 AS depth
      FROM ${folders} f
      WHERE f.context_source_id = ${sourceId}::uuid AND f.parent_id IS NULL
        AND f.name = ${dirs[0] ?? ""}
      UNION ALL
      SELECT f.id, f.name, f.parent_id, c.depth + 1
      FROM ${folders} f
      JOIN chain c ON f.parent_id = c.id
      WHERE f.name = (
        SELECT p.name FROM unnest(${dirs}::text[]) WITH ORDINALITY AS p(name, n)
        WHERE p.n = c.depth + 1
      )
    )
    SELECT d.id::text AS id
    FROM ${docs} d
    WHERE d.context_source_id = ${sourceId}::uuid
      AND d.name = ${file}
      AND ${
        dirs.length === 0
          ? sql`d.folder_id IS NULL`
          : sql`d.folder_id = (SELECT id FROM chain WHERE depth = ${dirs.length})`
      }
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function listChildrenSql(
  db: Database,
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  sourceId: string,
  parentId: string | null,
): Promise<Array<{ id: string; kind: "folder" | "document"; name: string; rank: string | null }>> {
  const tx = currentDrizzleDb(db);
  const folders =
    view.kind === "live" ? liveFoldersSql() : branchFoldersSql(view.branchId);
  const docs =
    view.kind === "live"
      ? liveDocumentsSql(treeDocId)
      : branchDocumentsSql(view.branchId, treeDocId);
  const parent = parentId === null ? sql`IS NULL` : sql`= ${parentId}::uuid`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, 'folder'::text AS kind, name, rank FROM ${folders} f
    WHERE f.context_source_id = ${sourceId}::uuid AND f.parent_id ${parent}
    UNION ALL
    SELECT id::text, 'document', name, rank FROM ${docs} d
    WHERE d.context_source_id = ${sourceId}::uuid AND d.folder_id ${parent}
    ORDER BY rank ASC NULLS LAST, id ASC
  `)) as unknown as Array<{ id: string; kind: "folder" | "document"; name: string; rank: string | null }>;
  return rows;
}

/** Full path of every visible document (export-inventory shape). */
export async function documentPathsSql(
  db: Database,
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  sourceId: string,
): Promise<Array<{ id: string; path: string }>> {
  const tx = currentDrizzleDb(db);
  const folders =
    view.kind === "live" ? liveFoldersSql() : branchFoldersSql(view.branchId);
  const docs =
    view.kind === "live"
      ? liveDocumentsSql(treeDocId)
      : branchDocumentsSql(view.branchId, treeDocId);
  const rows = (await tx.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT f.id, f.parent_id, f.name, f.name::text AS path
      FROM ${folders} f
      WHERE f.context_source_id = ${sourceId}::uuid AND f.parent_id IS NULL
      UNION ALL
      SELECT f.id, f.parent_id, f.name, walk.path || '/' || f.name
      FROM ${folders} f JOIN walk ON f.parent_id = walk.id
    )
    SELECT d.id::text AS id,
      CASE WHEN d.folder_id IS NULL THEN d.name
           ELSE (SELECT path FROM walk WHERE walk.id = d.folder_id) || '/' || d.name
      END AS path
    FROM ${docs} d
    WHERE d.context_source_id = ${sourceId}::uuid
    ORDER BY path
  `)) as unknown as Array<{ id: string; path: string }>;
  return rows;
}

/** documents -> folders -> context_sources (file-access join). */
export async function fileAccessJoinSql(
  db: Database,
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  documentId: string,
): Promise<{ documentId: string; folderId: string | null; sourceId: string; sourceSlug: string } | null> {
  const tx = currentDrizzleDb(db);
  const docs =
    view.kind === "live"
      ? liveDocumentsSql(treeDocId)
      : branchDocumentsSql(view.branchId, treeDocId);
  const folders =
    view.kind === "live" ? liveFoldersSql() : branchFoldersSql(view.branchId);
  const rows = (await tx.execute(sql`
    SELECT d.id::text AS document_id, d.folder_id::text AS folder_id,
      s.id::text AS source_id, s.slug AS source_slug
    FROM ${docs} d
    JOIN context_sources s ON s.id = d.context_source_id
    LEFT JOIN ${folders} f ON f.id = d.folder_id
    WHERE d.id = ${documentId}::uuid
    LIMIT 1
  `)) as unknown as Array<{
    document_id: string;
    folder_id: string | null;
    source_id: string;
    source_slug: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    documentId: row.document_id,
    folderId: row.folder_id,
    sourceId: row.source_id,
    sourceSlug: row.source_slug,
  };
}

/** Count of documents a draft changed (pendingDocuments analogue). */
export async function pendingDocumentsCount(
  db: Database,
  branchId: string,
): Promise<number> {
  const tx = currentDrizzleDb(db);
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM tree_branch_nodes
    WHERE branch_id = ${branchId} AND kind = 'document'
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export async function timeQuery<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/** Path of display names → document id, walking children the way resolvePath does. */
export async function resolvePathWalk(
  db: Database,
  view: { kind: "live" } | { kind: "branch"; branchId: string },
  treeDocId: string,
  sourceId: string,
  parts: string[],
): Promise<string | null> {
  if (parts.length === 0) return null;
  let parent: string | null = null;
  for (const dir of parts.slice(0, -1)) {
    const kids = await listChildrenSql(db, view, treeDocId, sourceId, parent);
    const hit = kids.find((row) => row.kind === "folder" && row.name === dir);
    if (!hit) return null;
    parent = hit.id;
  }
  const file = parts[parts.length - 1]!;
  const kids = await listChildrenSql(db, view, treeDocId, sourceId, parent);
  return (
    kids.find((row) => row.kind === "document" && row.name === file)?.id ??
    kids.find((row) => row.kind === "folder" && row.name === file)?.id ??
    null
  );
}
