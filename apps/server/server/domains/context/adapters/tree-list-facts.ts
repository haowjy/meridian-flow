/**
 * What only the server knows about a connection to a tree list (`Connection` in
 * `@meridian/project-tree`), read inside the admission's transaction under the list's lock. A
 * Work's close, archive or delete takes that lock first, so the Works read here are current.
 */
import { classifyFiletype, filetypeSchema } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import type { Connection } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { lineageHasLiveMember } from "../../../shared/draft-owner.js";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList } from "../ports/tree-list-store.js";

const editableTypes: ReadonlySet<string> = new Set(
  filetypeSchema.options.filter((type) => classifyFiletype(type).kind === "tracked"),
);

function schemaOf(type: string): string | null {
  const classification = classifyFiletype(type);
  return classification.kind === "tracked" ? classification.schemaType : null;
}

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
 * The open Works of a list, as their branch ids: the one meaning of "open" for both a write's
 * check (`Connection.drafts`) and the views the rows are replayed for. A Work is open while its
 * branch is active and the Work is neither archived nor deleted; a branch with no Work (a chat's)
 * is open while active. A project's list holds its project's Works, an account's its projects'.
 */
export async function openBranches(db: DrizzleDb, list: TreeList): Promise<Set<string>> {
  const rows = await currentDrizzleDb(db as Database).execute<{ id: string }>(sql`
    SELECT b.id::text AS id FROM branches b
    LEFT JOIN works w ON w.id = b.origin_work_id
    WHERE b.status = 'active'
      AND (w.id IS NULL OR (w.archived_at IS NULL AND w.deleted_at IS NULL))
      AND b.project_id IN (SELECT id FROM projects WHERE ${
        list.kind === "project"
          ? sql`id = ${list.projectId}::uuid`
          : sql`user_id = ${list.userId}::uuid`
      })`);
  return new Set(rows.map((row) => row.id));
}

/**
 * The connection's facts, or null when the account has no write access to the list: every
 * update from it is then refused before the check, as a read-only document's is.
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

  // An account's list holds the `user://` source, stored in its personal project; a project's
  // list holds the project's sources and its Works' and chats', never that one.
  const sources = await tx.execute<{ id: string; slug: string; scope: string }>(
    list.kind === "project"
      ? sql`SELECT s.id::text, s.slug, s.scope FROM context_sources s
          LEFT JOIN works w ON w.id = s.work_id
          WHERE s.deleted_at IS NULL AND NOT (s.scope = 'project' AND s.slug = 'user')
            AND (s.project_id = ${list.projectId}::uuid OR w.project_id = ${list.projectId}::uuid)
            AND (s.scope <> 'work' OR (w.archived_at IS NULL AND w.deleted_at IS NULL))
            AND (s.scope <> 'lineage' OR ${lineageHasLiveMember(sql`s.root_thread_id`)})`
      : sql`SELECT s.id::text, s.slug, s.scope FROM context_sources s
          WHERE s.deleted_at IS NULL AND s.project_id = ${project.id}::uuid
            AND s.scope = 'project' AND s.slug = 'user'`,
  );
  // Uploads are a chat's: a client's records never write them.
  const writable = sources.filter((source) => source.scope !== "chat");
  const unfiled =
    writable.find((source) => source.scope === "project" && source.slug === "unfiled") ??
    writable[0];
  if (!unfiled) return null;

  const drafts = await openBranches(tx, list);

  return {
    user: `user:${accountId}`,
    drafts,
    writableSources: new Set(writable.map((source) => source.id)),
    unfiledSource: unfiled.id,
    editableTypes,
    // The database is asked after admission, in the admitting transaction (`claimNodeIds`, which
    // sees every create the update holds, refused ones included) and a taken id rolls it back.
    takenElsewhere: () => false,
    sameSchema: (from, to) => {
      const fromSchema = schemaOf(from);
      return fromSchema !== null && fromSchema === schemaOf(to);
    },
  };
}
