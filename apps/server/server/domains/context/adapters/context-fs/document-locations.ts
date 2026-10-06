/** Transactional namespace claims and direct-to-identity document location history. */
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documentPreviousLocations,
  documents,
  folders,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../../shared/work-lifecycle-lock.js";
import type { ContextCommandScope } from "../../ports/context-command-transaction.js";

function namespaceKey(input: {
  projectId: string;
  userId: string;
  scheme: string;
  workId: string | null;
}): string {
  return input.scheme === "user"
    ? `context-user:${input.userId}`
    : `context-project:${input.projectId}:${input.workId ?? "none"}:${input.scheme}`;
}

/**
 * Seam C (file-access §5): Work rows in id order, the bound edit grants'
 * confirmation, then every advisory lock sorted by key, before provisioning
 * or publishing any source.
 */
export async function lockContextNamespaces(
  db: Database,
  owner: { projectId: string; userId: string },
  scopes: readonly ContextCommandScope[],
): Promise<void> {
  const workIds = [...new Set(scopes.flatMap((scope) => (scope.workId ? [scope.workId] : [])))];
  await requireLockedActiveWorks(db, workIds);
  await lockAdvisoryKeys(db, [
    ...(scopes.some((scope) => scope.scheme === "user") ? [owner.userId] : []),
    ...scopes.map((scope) => namespaceKey({ ...owner, ...scope })),
  ]);
}

/** Direct persistence callers use exactly the same logical locks as Context commands. */
export async function lockContextSources(
  db: Database,
  sourceIds: readonly string[],
): Promise<void> {
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
  await requireLockedActiveWorks(
    db,
    rows.flatMap((row) => (row.workId ? [row.workId] : [])),
  );
  await lockAdvisoryKeys(db, [
    ...rows.flatMap((row) => (row.scheme === "user" && row.userId ? [row.userId] : [])),
    ...rows.map((row) =>
      namespaceKey({
        projectId: (row.projectId ?? row.workProjectId) as string,
        userId: row.userId ?? "",
        workId: row.workId,
        scheme: row.scheme,
      }),
    ),
  ]);
}

async function lockAdvisoryKeys(db: Database, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await currentDrizzleDb(db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`,
    );
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
    WHERE d.context_source_id = ${source.sourceId} AND d.deleted_at IS NULL AND d.kind = 'content'
  `);
}

/** Called only after a successful claim; an outer rollback restores consumed history. */
export async function claimDocumentLocation(
  db: Database,
  sourceId: string,
  parentId: string | null,
  filename: string,
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const rows = await tx.execute<{ path: string }>(sql`
    WITH RECURSIVE parents AS (
      SELECT id, parent_id, name AS path FROM folders WHERE id = ${parentId}::uuid
      UNION ALL
      SELECT f.id, f.parent_id, f.name || '/' || p.path FROM folders f JOIN parents p ON f.id = p.parent_id
    )
    SELECT path FROM parents WHERE parent_id IS NULL
  `);
  const path = parentId === null ? filename : `${rows[0]?.path}/${filename}`;
  if (parentId !== null && !rows[0]) throw new Error("Namespace parent not found");
  await tx
    .delete(documentPreviousLocations)
    .where(
      and(
        eq(documentPreviousLocations.contextSourceId, sourceId),
        eq(documentPreviousLocations.path, path),
      ),
    );
}

/** Record all vacated files, then consume every destination occupant, including folders. */
export async function recordDocumentMove(
  db: Database,
  sourceId: string,
  destinationSourceId: string,
  previous: readonly NamespaceLocation[],
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const vacated = previous.filter((entry) => entry.kind === "file");
  // Bound statement parameter counts, not the atomic operation. Every batch joins the same transaction.
  for (let offset = 0; offset < vacated.length; offset += 500) {
    const batch = vacated.slice(offset, offset + 500);
    await tx
      .update(documents)
      .set({ locationVersion: sql`${documents.locationVersion} + 1` })
      .where(
        inArray(
          documents.id,
          batch.map((entry) => entry.id),
        ),
      );
    await tx.delete(documentPreviousLocations).where(
      and(
        eq(documentPreviousLocations.contextSourceId, sourceId),
        inArray(
          documentPreviousLocations.path,
          batch.map((entry) => entry.path),
        ),
      ),
    );
    await tx.insert(documentPreviousLocations).values(
      batch.map((entry) => ({
        contextSourceId: sourceId,
        path: entry.path,
        documentId: entry.id,
      })),
    );
  }
  const occupiedPaths = previous.map(
    (entry) => destinationPath + entry.path.slice(sourcePath.length),
  );
  for (let offset = 0; offset < occupiedPaths.length; offset += 500) {
    await tx
      .delete(documentPreviousLocations)
      .where(
        and(
          eq(documentPreviousLocations.contextSourceId, destinationSourceId),
          inArray(documentPreviousLocations.path, occupiedPaths.slice(offset, offset + 500)),
        ),
      );
  }
}

/** Caller holds the logical namespace lock; files and folders share rendered names. */
export async function hasOppositeContextEntry(
  db: Database,
  sourceId: string,
  parentId: string | null,
  filename: string,
  kind: "file" | "folder",
): Promise<boolean> {
  const tx = currentDrizzleDb(db);
  if (kind === "file") {
    const [row] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.name, filename),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return !!row;
  }
  const [row] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.contextSourceId, sourceId),
        contentDocumentPredicate(),
        parentId === null ? isNull(documents.folderId) : eq(documents.folderId, parentId),
        sql`CASE WHEN ${documents.extension} = '' THEN ${documents.name} ELSE ${documents.name} || '.' || ${documents.extension} END = ${filename}`,
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}
