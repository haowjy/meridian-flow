/**
 * What only the server knows about a connection to a tree list (`Connection` in
 * `@meridian/project-tree`), read inside the admission's transaction under the list's lock. A
 * Work's close, archive or delete takes that lock first, so the Works read here are current.
 */
import type { Database } from "@meridian/database";
import type { Connection } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { closedWhyOf } from "../../../shared/tree-owners.js";
import { readOwners } from "../../../shared/work-lifecycle-lock.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownerFrom, ownerProjectIdSql } from "../tree/source-owner.js";

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

/** The list a source's nodes are in: its owner's, a project's (a Work's source is its project's) or the account's. */
export async function treeListOfSource(db: DrizzleDb, sourceId: string): Promise<TreeList> {
  const [row] = await currentDrizzleDb(db as Database).execute<{
    project_id: string | null;
    user_id: string | null;
  }>(sql`
    SELECT ${ownerProjectIdSql("s", "w")}::text AS project_id, s.user_id::text AS user_id
    FROM context_sources s LEFT JOIN works w ON w.id = s.work_id
    WHERE s.id = ${sourceId}::uuid`);
  if (!row) throw new Error(`Context source ${sourceId} is gone`);
  return ownerFrom({ projectId: row.project_id, userId: row.user_id });
}

/**
 * The drafts of a list's projects, as ids: a Work's (open, archived, or deleted and restorable)
 * or a chat's. A draft ends only when its Work is purged for good, which discards it first. A
 * project's list holds its project's drafts, an account's its projects'. Only `open` ones may
 * write.
 */
async function activeBranches(db: DrizzleDb, list: TreeList, open: boolean): Promise<Set<string>> {
  const rows = await currentDrizzleDb(db as Database).execute<{ id: string }>(sql`
    SELECT b.id AS id FROM drafts b
    LEFT JOIN works w ON w.draft_id = b.id
    WHERE true
      ${open ? sql`AND (w.id IS NULL OR (w.archived_at IS NULL AND w.deleted_at IS NULL))` : sql``}
      AND b.project_id IN (SELECT id FROM projects WHERE ${
        list.kind === "project"
          ? sql`id = ${list.projectId}::uuid`
          : sql`user_id = ${list.userId}::uuid`
      })`);
  return new Set(rows.map((row) => row.id));
}

/**
 * The Works whose view the rows keep (`draft_tree_nodes`, pending text counted): every branch
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
 * The facts admission needs: open branches and whether each source is closed or gone.
 * Null when the list is not the account's (the project or account is gone or another's).
 */
export async function readConnection(
  db: DrizzleDb,
  list: TreeList,
  accountId: string,
): Promise<Connection | null> {
  const tx = currentDrizzleDb(db as Database);
  if (list.kind === "account") {
    const [account] = await tx.execute<{ id: string }>(
      sql`SELECT id::text FROM users WHERE id = ${list.userId}::uuid`,
    );
    if (!account || account.id !== accountId) return null;
  } else {
    const [project] = await tx.execute<{ id: string; owner: string }>(
      sql`SELECT id::text, user_id::text AS owner FROM projects
      WHERE id = ${list.projectId}::uuid AND deleted_at IS NULL`,
    );
    if (!project || project.owner !== accountId) return null;
  }
  const rows = await tx.execute<{
    id: string;
    workId: string | null;
    rootThreadId: string | null;
  }>(sql`
    SELECT s.id::text AS id, s.work_id::text AS "workId", s.root_thread_id::text AS "rootThreadId"
    FROM context_sources s
    LEFT JOIN works w ON w.id = s.work_id
    WHERE ${
      list.kind === "project"
        ? sql`${ownerProjectIdSql("s", "w")} = ${list.projectId}::uuid`
        : sql`s.user_id = ${list.userId}::uuid`
    }`);
  const owners = await readOwners(
    db,
    rows.flatMap((row) => (row.workId ? [row.workId] : [])),
    rows.flatMap((row) => (!row.workId && row.rootThreadId ? [row.rootThreadId] : [])),
  );
  const open = new Set(rows.filter((row) => !closedWhyOf(row, owners)).map((row) => row.id));
  return {
    drafts: await openBranches(tx, list),
    closed: (source) => !open.has(source),
  };
}
