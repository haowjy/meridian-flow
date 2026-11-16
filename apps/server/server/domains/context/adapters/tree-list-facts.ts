/**
 * What only the server knows about a connection to a tree list (`Connection` in
 * `@meridian/project-tree`), read inside the admission's transaction under the list's lock. A
 * Work's close, archive or delete takes that lock first, so the Works read here are current.
 */
import type { Database } from "@meridian/database";
import type { Connection } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList } from "../ports/tree-list-store.js";

/** The list's id: its project's or its account's `tree_list_id`, or null when that is gone. */
export async function listIdOf(db: DrizzleDb, list: TreeList): Promise<string | null> {
  const tx = currentDrizzleDb(db as Database);
  const [row] = await tx.execute<{ id: string }>(
    list.kind === "project"
      ? sql`SELECT tree_list_id::text AS id FROM projects WHERE id = ${list.projectId}::uuid`
      : sql`SELECT tree_list_id::text AS id FROM users WHERE id = ${list.userId}::uuid`,
  );
  return row?.id ?? null;
}

/**
 * The list a source's nodes are in: the account's for its `user://` source (the personal
 * project's source with slug `user`), else the list of the project that holds the source (a
 * Work's source belongs to the Work's project).
 */
export async function treeListOfSource(db: DrizzleDb, sourceId: string): Promise<TreeList> {
  const [row] = await currentDrizzleDb(db as Database).execute<{
    project_id: string;
    user_id: string;
    account: boolean;
  }>(sql`
    SELECT p.id::text AS project_id, p.user_id::text AS user_id,
      (s.scope = 'project' AND s.slug = 'user') AS account
    FROM context_sources s
      LEFT JOIN works w ON w.id = s.work_id
      JOIN projects p ON p.id = COALESCE(s.project_id, w.project_id)
    WHERE s.id = ${sourceId}::uuid`);
  if (!row) throw new Error(`Context source ${sourceId} is gone`);
  return row.account
    ? { kind: "account", userId: row.user_id }
    : { kind: "project", projectId: row.project_id };
}

/** The project that owns the documents a list's creates make: an account's list is its personal project's. */
export async function projectOfList(db: DrizzleDb, list: TreeList): Promise<string> {
  if (list.kind === "project") return list.projectId;
  const [row] = await currentDrizzleDb(db as Database).execute<{ id: string }>(
    sql`SELECT id::text FROM projects WHERE user_id = ${list.userId}::uuid AND is_personal AND deleted_at IS NULL`,
  );
  if (!row) throw new Error("The account has no personal project");
  return row.id;
}

/**
 * The branches of a list's projects that can still come back, as ids: a Work's (open,
 * archived, or deleted and restorable) or a chat's, while the branch is active. A branch ends
 * with a whole Discard, and a Work purged for good has its branches discarded first. A project's
 * list holds its project's branches, an account's its projects'. Only `open` ones may write.
 */
async function activeBranches(db: DrizzleDb, list: TreeList, open: boolean): Promise<Set<string>> {
  const rows = await currentDrizzleDb(db as Database).execute<{ id: string }>(sql`
    SELECT b.id::text AS id FROM branches b
    LEFT JOIN works w ON w.id = b.origin_work_id
    WHERE b.status = 'active'
      ${open ? sql`AND (w.id IS NULL OR (w.archived_at IS NULL AND w.deleted_at IS NULL))` : sql``}
      AND b.project_id IN (SELECT id FROM projects WHERE ${
        list.kind === "project"
          ? sql`id = ${list.projectId}::uuid`
          : sql`user_id = ${list.userId}::uuid`
      })`);
  return new Set(rows.map((row) => row.id));
}

/**
 * The Works whose view the rows keep (`branch_tree_nodes`, pending text counted): every branch
 * that can still come back, so an archived Work's drafted creates and a restorable deleted
 * Work's changes are never in no view. Readers that show only open Works filter by the Work's
 * state themselves.
 */
export const keptBranches = (db: DrizzleDb, list: TreeList) => activeBranches(db, list, false);

/**
 * The open Works of a list: the one meaning of "open" for a write's check
 * (`Connection.drafts`). A Work is open while its branch is active and the Work is neither
 * archived nor deleted; a branch with no Work (a chat's) is open while active.
 */
export const openBranches = (db: DrizzleDb, list: TreeList) => activeBranches(db, list, true);

/**
 * The facts the server decides a create by: the open branches, and the sources of Works that are
 * closed (archived or deleted), which nothing may be created in. Null when the list is not the
 * account's (the project or account is gone or another's).
 */
export async function readConnection(
  db: DrizzleDb,
  list: TreeList,
  accountId: string,
): Promise<Connection | null> {
  const tx = currentDrizzleDb(db as Database);
  const [project] = await tx.execute<{ id: string; owner: string }>(
    list.kind === "project"
      ? sql`SELECT id::text, user_id::text AS owner FROM projects
          WHERE id = ${list.projectId}::uuid AND deleted_at IS NULL`
      : sql`SELECT id::text, user_id::text AS owner FROM projects
          WHERE user_id = ${list.userId}::uuid AND is_personal AND deleted_at IS NULL`,
  );
  if (!project || project.owner !== accountId) return null;
  const sources = await tx.execute<{ id: string; closed: boolean }>(sql`
    SELECT s.id::text AS id,
      (s.deleted_at IS NOT NULL OR (s.scope = 'work' AND (w.id IS NULL OR w.archived_at IS NOT NULL OR w.deleted_at IS NOT NULL))) AS closed
    FROM context_sources s
    LEFT JOIN works w ON w.id = s.work_id
    WHERE COALESCE(s.project_id, w.project_id) = ${project.id}::uuid`);
  const openSources = new Set(
    sources.filter((source) => !source.closed).map((source) => source.id),
  );
  return {
    drafts: await openBranches(tx, list),
    closed: (source) => !openSources.has(source),
  };
}
