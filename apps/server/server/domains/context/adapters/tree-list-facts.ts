/**
 * What only the server knows about a connection to a tree list (`Connection` in
 * `@meridian/project-tree`), read inside the admission's transaction under the list's lock, so
 * what a Work's close or a source's end changed is current.
 */
import { classifyFiletype, filetypeSchema } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import type { Connection } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { lineageHasLiveMember } from "../../../shared/draft-owner.js";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { TreeList } from "../ports/tree-list-store.js";

const editableTypes: ReadonlySet<string> = new Set(
  filetypeSchema.options.filter((type) => classifyFiletype(type).kind === "tracked"),
);

function schemaOf(type: string): string | null {
  const classification = classifyFiletype(type);
  return classification.kind === "tracked" ? classification.schemaType : null;
}

/** Node ids used by a row anywhere: a live row, a Work's row, or a document that has none yet. */
export async function usedNodeIds(db: DrizzleDb, ids: readonly string[]): Promise<Set<string>> {
  const candidates = ids.filter(isUuid);
  if (candidates.length === 0) return new Set();
  const list = sql.join(
    candidates.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await currentDrizzleDb(db as Database).execute<{ id: string }>(sql`
    SELECT id::text AS id FROM tree_nodes WHERE id IN (${list})
    UNION SELECT id::text FROM branch_tree_nodes WHERE id IN (${list})
    UNION SELECT id::text FROM documents WHERE id IN (${list})`);
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
  takenIds: ReadonlySet<string>,
): Promise<Connection | null> {
  const tx = currentDrizzleDb(db as Database);
  const projectId = list.kind === "project" ? list.projectId : null;
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

  const drafts = await tx.execute<{ id: string }>(sql`
    SELECT b.id::text FROM branches b
    LEFT JOIN works w ON w.id = b.origin_work_id
    WHERE b.status = 'active'
      AND b.project_id IN (SELECT id FROM projects WHERE user_id = ${accountId}::uuid
        ${projectId === null ? sql`` : sql`AND id = ${projectId}::uuid`})
      AND (b.origin_work_id IS NULL OR (w.archived_at IS NULL AND w.deleted_at IS NULL))`);

  return {
    user: `user:${accountId}`,
    drafts: new Set(drafts.map((row) => row.id)),
    writableSources: new Set(writable.map((source) => source.id)),
    unfiledSource: unfiled.id,
    editableTypes,
    sameSchema: (from, to) => {
      const fromSchema = schemaOf(from);
      return fromSchema !== null && fromSchema === schemaOf(to);
    },
    takenElsewhere: (id) => takenIds.has(id),
  };
}
