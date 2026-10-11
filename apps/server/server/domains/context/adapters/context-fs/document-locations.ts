/** Transactional namespace locks and live-path occupancy checks for context commands. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, works } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../../shared/work-lifecycle-lock.js";
import type { ContextCommandScope } from "../../ports/context-command-transaction.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "../../tree/tree-view.js";

export type ContextNamespace = {
  projectId: string;
  userId: string;
  scheme: string;
  workId: string | null;
};

export function contextNamespaceKey(input: ContextNamespace): string {
  return input.scheme === "user"
    ? `context-user:${input.userId}`
    : `context-project:${input.projectId}:${input.workId ?? "none"}:${input.scheme}`;
}

/** Acquire only namespace locks. Callers are responsible for Work checks. */
export async function lockNamespaceKeys(
  db: Database,
  namespaces: readonly ContextNamespace[],
): Promise<void> {
  await lockAdvisoryKeys(db, namespaces.map(contextNamespaceKey));
}

/**
 * Seam C (file-access §5): Work rows in id order, the bound edit grants'
 * confirmation, then every advisory lock sorted by key, before provisioning
 * or publishing any source. A draft write's Work joins the Work locks, and
 * `afterWorkLocks` (the draft row, contract §14) runs before any namespace key.
 */
export async function lockContextNamespaces(
  db: Database,
  owner: { projectId: string; userId: string },
  scopes: readonly ContextCommandScope[],
  options: {
    workIds?: readonly string[];
    sourceIds?: readonly string[];
    afterWorkLocks?: () => Promise<void>;
  } = {},
): Promise<void> {
  const sources = await sourceNamespaces(db, options.sourceIds ?? []);
  const workIds = [
    ...new Set([
      ...scopes.flatMap((scope) => (scope.workId ? [scope.workId] : [])),
      ...(options.workIds ?? []),
      ...sources.flatMap((source) => (source.workId ? [source.workId] : [])),
    ]),
  ];
  await requireLockedActiveWorks(db, workIds);
  await options.afterWorkLocks?.();
  await lockAdvisoryKeys(db, [
    ...(scopes.some((scope) => scope.scheme === "user") ? [owner.userId] : []),
    ...scopes.map((scope) => contextNamespaceKey({ ...owner, ...scope })),
    ...sources.flatMap((source) =>
      source.scheme === "user" && source.userId ? [source.userId] : [],
    ),
    ...sources.map(contextNamespaceKey),
  ]);
}

/** Direct persistence callers use exactly the same logical locks as Context commands. */
export async function lockContextSources(
  db: Database,
  sourceIds: readonly string[],
): Promise<void> {
  const rows = await sourceNamespaces(db, sourceIds);
  await requireLockedActiveWorks(
    db,
    rows.flatMap((row) => (row.workId ? [row.workId] : [])),
  );
  await lockAdvisoryKeys(db, [
    ...rows.flatMap((row) => (row.scheme === "user" && row.userId ? [row.userId] : [])),
    ...rows.map(contextNamespaceKey),
  ]);
}

/**
 * Namespace keys of the sources these documents occupy now, deleted rows included (a restore
 * locks before it unhides), together with explicit sources (an Apply's final locations), in one
 * sorted acquisition. Arrivals that are not authored writes (Apply, Work restore) take these
 * after their Work locks and before any holder lock (contract §9.2, O6).
 */
export async function lockDocumentNamespaces(
  db: Database,
  documentIds: readonly string[],
  sourceIds: readonly string[] = [],
): Promise<void> {
  if (documentIds.length === 0 && sourceIds.length === 0) return;
  const rows =
    documentIds.length === 0
      ? []
      : await currentDrizzleDb(db)
          .selectDistinct({ sourceId: documents.contextSourceId })
          .from(documents)
          .where(inArray(documents.id, [...new Set(documentIds)]));
  await lockNamespaceKeys(
    db,
    await sourceNamespaces(db, [...rows.map((row) => row.sourceId), ...sourceIds]),
  );
}

async function sourceNamespaces(
  db: Database,
  sourceIds: readonly string[],
): Promise<ContextNamespace[]> {
  if (sourceIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({
      projectId: contextSources.projectId,
      userId: projects.userId,
      workId: contextSources.workId,
      workProjectId: works.projectId,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(projects, eq(projects.id, contextSources.projectId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return rows.map((row) => ({
    projectId: (row.projectId ?? row.workProjectId) as string,
    userId: row.userId ?? "",
    workId: row.workId,
    scheme: row.scheme,
  }));
}

async function lockAdvisoryKeys(db: Database, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await currentDrizzleDb(db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`,
    );
}

/**
 * Row-lock every document a move mutates (moved files and an overwrite victim), sorted. NO KEY
 * UPDATE is compatible with the journal's holder FK KEY SHARE but orders a same-source move
 * against derive certification and other moves of the same rows.
 */
export async function lockMovedDocumentRows(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<void> {
  if (documentIds.length === 0) return;
  await currentDrizzleDb(db)
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, [...new Set(documentIds)]))
    .orderBy(documents.id)
    .for("no key update");
}

export type NamespaceLocation = { id: string; path: string; kind: "file" | "directory" };

/** Enumerate only the moved subtree, using its already CAS-checked root path. */
export async function readTreeLocations(
  db: Database,
  source: { kind: "file" | "directory"; nodeId: string; sourceId: string; path: string },
): Promise<NamespaceLocation[]> {
  if (source.kind === "file") return [{ id: source.nodeId, path: source.path, kind: "file" }];
  return currentDrizzleDb(db).execute<NamespaceLocation>(sql`
    WITH RECURSIVE paths AS (
      SELECT id, ${source.path}::text AS path FROM folders
      WHERE id = ${source.nodeId} AND context_source_id = ${source.sourceId} AND deleted_at IS NULL
      UNION ALL
      SELECT f.id, p.path || '/' || f.name FROM folders f JOIN paths p ON f.parent_id = p.id
      WHERE f.context_source_id = ${source.sourceId} AND f.deleted_at IS NULL
    )
    SELECT id::text, path, 'directory' AS kind FROM paths
    UNION ALL
    SELECT d.id::text, p.path || '/' || d.name ||
      CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS path, 'file' AS kind
    FROM documents d JOIN paths p ON d.folder_id = p.id
    WHERE d.context_source_id = ${source.sourceId} AND d.deleted_at IS NULL
  `);
}

/**
 * Caller holds the logical namespace lock; files and folders share rendered names. Only
 * the live tree occupies a path: a hidden node never blocks a live entry.
 */
export async function hasOppositeContextEntry(
  db: Database,
  sourceId: string,
  parentId: string | null,
  filename: string,
  kind: "file" | "folder",
): Promise<boolean> {
  const tx = currentDrizzleDb(db);
  if (kind === "file") {
    const vf = visibleFolders(LIVE_TREE);
    const [row] = await tx
      .select({ id: vf.id })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, sourceId as never),
          parentId === null ? isNull(vf.parentId) : eq(vf.parentId, parentId as never),
          eq(vf.name, filename),
        ),
      )
      .limit(1);
    return !!row;
  }
  const vd = visibleDocuments(LIVE_TREE);
  const [row] = await tx
    .select({ id: vd.id })
    .from(vd)
    .where(
      and(
        eq(vd.contextSourceId, sourceId as never),
        parentId === null ? isNull(vd.folderId) : eq(vd.folderId, parentId as never),
        sql`CASE WHEN ${vd.extension} = '' THEN ${vd.name} ELSE ${vd.name} || '.' || ${vd.extension} END = ${filename}`,
      ),
    )
    .limit(1);
  return !!row;
}
