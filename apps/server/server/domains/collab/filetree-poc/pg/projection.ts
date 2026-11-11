/** Live folders/documents plus per-branch overlay, kept in step with replay. */
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../../shared/drizzle-transaction.js";
import {
  isSourceRoot,
  LIVE,
  materialize,
  sourceIdOf,
  type TreeNode,
  type TreeOp,
  type View,
  viewOps,
} from "./tree-log.js";
import type * as Y from "yjs";

export type ProjectedRow = {
  id: string;
  kind: "folder" | "document";
  parentId: string | null;
  contextSourceId: string;
  name: string;
  rank: string;
  deleted: boolean;
};

export function sqlParent(parent: string | null): string | null {
  if (!parent || isSourceRoot(parent)) return null;
  return parent;
}

export function contextSourceOf(node: TreeNode, nodes: Map<string, TreeNode>): string {
  let at: string | null = isSourceRoot(node.id) ? node.id : node.parent;
  for (let guard = 0; at && guard <= nodes.size + 2; guard += 1) {
    const source = sourceIdOf(at);
    if (source) return source;
    at = nodes.get(at)?.parent ?? null;
  }
  throw new Error(`no source root above ${node.id}`);
}

export function projectedRows(nodes: Map<string, TreeNode>): Map<string, ProjectedRow> {
  const out = new Map<string, ProjectedRow>();
  for (const node of nodes.values()) {
    if (isSourceRoot(node.id)) continue;
    out.set(node.id, {
      id: node.id,
      kind: node.kind === "folder" ? "folder" : "document",
      parentId: sqlParent(node.parent),
      contextSourceId: contextSourceOf(node, nodes),
      name: node.displayName,
      rank: node.rank,
      deleted: node.trashed,
    });
  }
  return out;
}

export function sameRow(a: ProjectedRow, b: ProjectedRow): boolean {
  return (
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.contextSourceId === b.contextSourceId &&
    a.name === b.name &&
    a.rank === b.rank &&
    a.deleted === b.deleted
  );
}

export function overlayAgainstLive(
  live: Map<string, ProjectedRow>,
  draft: Map<string, ProjectedRow>,
): Array<ProjectedRow & { existsOnlyInDraft: boolean }> {
  const out: Array<ProjectedRow & { existsOnlyInDraft: boolean }> = [];
  for (const row of draft.values()) {
    const base = live.get(row.id);
    if (!base) out.push({ ...row, existsOnlyInDraft: true });
    else if (!sameRow(base, row)) out.push({ ...row, existsOnlyInDraft: false });
  }
  for (const row of live.values()) {
    if (!draft.has(row.id)) {
      out.push({ ...row, deleted: true, existsOnlyInDraft: false });
    }
  }
  return out;
}

function parentFirstFolders(rows: ProjectedRow[]): ProjectedRow[] {
  const folders = rows.filter((row) => row.kind === "folder");
  const have = new Set(folders.map((row) => row.id));
  const placed = new Set<string>();
  const out: ProjectedRow[] = [];
  let guard = 0;
  while (out.length < folders.length && guard < folders.length + 2) {
    guard += 1;
    for (const row of folders) {
      if (placed.has(row.id)) continue;
      if (!row.parentId || placed.has(row.parentId) || !have.has(row.parentId)) {
        placed.add(row.id);
        out.push(row);
      }
    }
  }
  return out;
}

async function upsertLive(db: DrizzleDb, row: ProjectedRow): Promise<void> {
  const deletedAt = row.deleted ? sql`now()` : sql`null`;
  if (row.kind === "folder") {
    await db.execute(sql`
      INSERT INTO folders (id, context_source_id, parent_id, name, rank, deleted_at, hidden)
      VALUES (${row.id}::uuid, ${row.contextSourceId}::uuid, ${row.parentId}::uuid,
        ${row.name}, ${row.rank}, ${deletedAt}, false)
      ON CONFLICT (id) DO UPDATE SET
        context_source_id = EXCLUDED.context_source_id,
        parent_id = EXCLUDED.parent_id,
        name = EXCLUDED.name,
        rank = EXCLUDED.rank,
        deleted_at = EXCLUDED.deleted_at,
        updated_at = now()`);
    return;
  }
  await db.execute(sql`
    INSERT INTO documents (id, context_source_id, folder_id, name, extension, file_type, rank,
      deleted_at, deletion_reason, hidden)
    VALUES (${row.id}::uuid, ${row.contextSourceId}::uuid, ${row.parentId}::uuid,
      ${row.name}, '', 'markdown', ${row.rank}, ${deletedAt},
      ${row.deleted ? sql`'deleted'` : sql`null`}, false)
    ON CONFLICT (id) DO UPDATE SET
      context_source_id = EXCLUDED.context_source_id,
      folder_id = EXCLUDED.folder_id,
      name = EXCLUDED.name,
      rank = EXCLUDED.rank,
      deleted_at = EXCLUDED.deleted_at,
      deletion_reason = EXCLUDED.deletion_reason,
      updated_at = now()`);
}

export async function readLiveRows(
  db: DrizzleDb,
  treeDocId: string,
  sourceId: string,
): Promise<Map<string, ProjectedRow>> {
  const out = new Map<string, ProjectedRow>();
  const folderRows = await db.execute(sql`
    SELECT id::text AS id, context_source_id::text AS source, parent_id::text AS parent,
      name, rank, (deleted_at IS NOT NULL) AS deleted
    FROM folders WHERE context_source_id = ${sourceId}::uuid`);
  for (const row of folderRows as unknown as Array<{
    id: string; source: string; parent: string | null; name: string; rank: string | null; deleted: boolean;
  }>) {
    out.set(row.id, {
      id: row.id,
      kind: "folder",
      parentId: row.parent,
      contextSourceId: row.source,
      name: row.name,
      rank: row.rank ?? "",
      deleted: row.deleted,
    });
  }
  const docRows = await db.execute(sql`
    SELECT id::text AS id, context_source_id::text AS source, folder_id::text AS parent,
      name, rank, (deleted_at IS NOT NULL) AS deleted
    FROM documents WHERE id <> ${treeDocId}::uuid AND NOT hidden
      AND context_source_id = ${sourceId}::uuid`);
  for (const row of docRows as unknown as Array<{
    id: string; source: string; parent: string | null; name: string; rank: string | null; deleted: boolean;
  }>) {
    out.set(row.id, {
      id: row.id,
      kind: "document",
      parentId: row.parent,
      contextSourceId: row.source,
      name: row.name,
      rank: row.rank ?? "",
      deleted: row.deleted,
    });
  }
  return out;
}

export async function syncLiveRows(
  db: Database,
  live: Map<string, ProjectedRow>,
  treeDocId: string,
  sourceId: string,
): Promise<{ upserts: number }> {
  const tx = currentDrizzleDb(db);
  const existing = await readLiveRows(tx, treeDocId, sourceId);
  const changed: ProjectedRow[] = [];
  for (const row of live.values()) {
    const prev = existing.get(row.id);
    if (!prev || !sameRow(prev, row)) changed.push(row);
  }
  const ordered = [
    ...parentFirstFolders(changed),
    ...changed.filter((row) => row.kind === "document"),
  ];
  let upserts = 0;
  for (const row of ordered) {
    await upsertLive(tx, row);
    upserts += 1;
  }
  for (const [id, prev] of existing) {
    if (live.has(id) || prev.deleted) continue;
    await tx.execute(sql`
      UPDATE folders SET deleted_at = coalesce(deleted_at, now()) WHERE id = ${id}::uuid`);
    await tx.execute(sql`
      UPDATE documents SET deleted_at = coalesce(deleted_at, now()),
        deletion_reason = coalesce(deletion_reason, 'deleted')
      WHERE id = ${id}::uuid AND id <> ${treeDocId}::uuid`);
    upserts += 1;
  }
  return { upserts };
}

export type OverlayRow = ProjectedRow & { existsOnlyInDraft: boolean };

export function liveChanged(
  prev: Map<string, ProjectedRow>,
  next: Map<string, ProjectedRow>,
): { upserts: ProjectedRow[]; gone: string[] } {
  const upserts: ProjectedRow[] = [];
  for (const row of next.values()) {
    const was = prev.get(row.id);
    if (!was || !sameRow(was, row)) upserts.push(row);
  }
  const gone: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) gone.push(id);
  return { upserts, gone };
}

export function overlayChanged(
  prev: Map<string, OverlayRow>,
  next: Map<string, OverlayRow>,
): { upserts: OverlayRow[]; gone: string[] } {
  const upserts: OverlayRow[] = [];
  for (const row of next.values()) {
    const was = prev.get(row.id);
    if (!was || !sameRow(was, row) || was.existsOnlyInDraft !== row.existsOnlyInDraft) upserts.push(row);
  }
  const gone: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) gone.push(id);
  return { upserts, gone };
}

export async function writeLiveChanged(
  db: Database,
  prev: Map<string, ProjectedRow>,
  next: Map<string, ProjectedRow>,
  treeDocId: string,
): Promise<number> {
  const tx = currentDrizzleDb(db);
  const { upserts, gone } = liveChanged(prev, next);
  const ordered = [
    ...parentFirstFolders(upserts),
    ...upserts.filter((row) => row.kind === "document"),
  ];
  let n = 0;
  for (const row of ordered) {
    await upsertLive(tx, row);
    n += 1;
  }
  for (const id of gone) {
    await tx.execute(sql`
      UPDATE folders SET deleted_at = coalesce(deleted_at, now()) WHERE id = ${id}::uuid`);
    await tx.execute(sql`
      UPDATE documents SET deleted_at = coalesce(deleted_at, now()),
        deletion_reason = coalesce(deletion_reason, 'deleted')
      WHERE id = ${id}::uuid AND id <> ${treeDocId}::uuid`);
    n += 1;
  }
  return n;
}

export async function writeOverlayChanged(
  db: Database,
  branchId: string,
  prev: Map<string, OverlayRow>,
  next: Map<string, OverlayRow>,
): Promise<number> {
  const tx = currentDrizzleDb(db);
  const { upserts, gone } = overlayChanged(prev, next);
  let n = 0;
  for (const id of gone) {
    await tx.execute(
      sql`DELETE FROM tree_branch_nodes WHERE branch_id = ${branchId} AND node_id = ${id}::uuid`,
    );
    n += 1;
  }
  for (const row of upserts) {
    await tx.execute(sql`
      INSERT INTO tree_branch_nodes (branch_id, node_id, kind, parent_id, context_source_id, name, rank, deleted, exists_only_in_draft)
      VALUES (${branchId}, ${row.id}::uuid, ${row.kind}, ${row.parentId}::uuid, ${row.contextSourceId}::uuid,
        ${row.name}, ${row.rank}, ${row.deleted}, ${row.existsOnlyInDraft})
      ON CONFLICT (branch_id, node_id) DO UPDATE SET
        kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id, context_source_id = EXCLUDED.context_source_id,
        name = EXCLUDED.name, rank = EXCLUDED.rank, deleted = EXCLUDED.deleted,
        exists_only_in_draft = EXCLUDED.exists_only_in_draft`);
    n += 1;
  }
  return n;
}

export function overlayMap(
  rows: Array<ProjectedRow & { existsOnlyInDraft: boolean }>,
): Map<string, OverlayRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

export async function replaceBranchOverlay(
  db: Database,
  branchId: string,
  overlay: Array<ProjectedRow & { existsOnlyInDraft: boolean }>,
): Promise<void> {
  const tx = currentDrizzleDb(db);
  await tx.execute(sql`DELETE FROM tree_branch_nodes WHERE branch_id = ${branchId}`);
  for (const row of overlay) {
    await tx.execute(sql`
      INSERT INTO tree_branch_nodes (branch_id, node_id, kind, parent_id, context_source_id, name, rank, deleted, exists_only_in_draft)
      VALUES (${branchId}, ${row.id}::uuid, ${row.kind}, ${row.parentId}::uuid, ${row.contextSourceId}::uuid,
        ${row.name}, ${row.rank}, ${row.deleted}, ${row.existsOnlyInDraft})`);
  }
}

export function draftsIn(ops: readonly TreeOp[]): string[] {
  return [...new Set(ops.flatMap((op) => (op.draft ? [op.draft] : [])))];
}

export async function syncProjection(
  db: Database,
  doc: Y.Doc,
  treeDocId: string,
  sourceId: string,
): Promise<{ liveUpserts: number; drafts: number }> {
  const liveProj = materialize(doc, LIVE);
  const liveRows = projectedRows(liveProj.nodes);
  const { upserts } = await syncLiveRows(db, liveRows, treeDocId, sourceId);
  const drafts = draftsIn(viewOps(doc, LIVE).concat(
    // include drafted records even though viewOps(LIVE) is live-only
    [],
  ));
  const allDrafts = draftsIn(
    (doc.getArray<TreeOp>("ops").toArray() as TreeOp[]),
  );
  for (const draft of allDrafts) {
    const view: View = { draft };
    const draftRows = projectedRows(materialize(doc, view).nodes);
    await replaceBranchOverlay(db, draft, overlayAgainstLive(liveRows, draftRows));
  }
  return { liveUpserts: upserts, drafts: allDrafts.length };
}

export { eq, and };
