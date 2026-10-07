/** Context-tree adapter for the codec's image paths, loaded fresh for each document operation. */

import { AsyncLocalStorage } from "node:async_hooks";
import { parseContextUri } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import type { AssetPathResolver } from "@meridian/markup";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import {
  type AssetPathProject,
  createUnscopedAssetPathObserver,
  type DocumentAssetPaths,
} from "../../collab/index.js";
import type { EventSink } from "../../observability/index.js";

type ImageLocation = { id: string; path: string; deleted: boolean };

async function resolveProjectId(db: Database, project: AssetPathProject): Promise<string | null> {
  if ("projectId" in project) return isUuid(project.projectId) ? project.projectId : null;
  const id = "threadId" in project ? project.threadId : project.documentId;
  if (!isUuid(id)) return null;
  const [row] = await currentDrizzleDb(db).execute<{ project_id: string | null }>(
    "threadId" in project
      ? sql`SELECT t.project_id::text AS project_id FROM threads t WHERE t.id = ${id}`
      : sql`
        SELECT COALESCE(cs.project_id, w.project_id)::text AS project_id
        FROM documents d
        JOIN context_sources cs ON cs.id = d.context_source_id
        LEFT JOIN works w ON w.id = cs.work_id
        WHERE d.id = ${id}`,
  );
  return row?.project_id ?? null;
}

/**
 * Every image in the project's manuscript, wherever it sits, including
 * deleted ones at the location they were deleted from. Paths are
 * manuscript-root-relative: the bare spelling `parseContextUri` reads as
 * `manuscript://`, and the one figure upload has always written.
 *
 * Deleted rows count, so the partial `deleted_at IS NULL` indexes don't serve
 * this; `folders_context_root`, `folders_parent` and `documents_context_images`
 * keep it to the project's own rows.
 */
async function loadImageLocations(db: Database, projectId: string): Promise<ImageLocation[]> {
  return currentDrizzleDb(db).execute<ImageLocation>(sql`
    WITH RECURSIVE manuscript AS (
      SELECT cs.id FROM context_sources cs
      WHERE cs.project_id = ${projectId} AND cs.slug = 'manuscript'
        AND cs.work_id IS NULL AND cs.deleted_at IS NULL
    ),
    paths AS (
      SELECT f.id, f.context_source_id, f.name AS path, f.deleted_at IS NOT NULL AS deleted
      FROM folders f
      WHERE f.parent_id IS NULL AND f.context_source_id IN (SELECT id FROM manuscript)
      UNION ALL
      SELECT f.id, f.context_source_id, p.path || '/' || f.name,
        p.deleted OR f.deleted_at IS NOT NULL
      FROM folders f JOIN paths p
        ON f.parent_id = p.id AND f.context_source_id = p.context_source_id
    )
    SELECT d.id::text AS id,
      COALESCE(p.path || '/', '') || d.name ||
        CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS path,
      d.deleted_at IS NOT NULL OR COALESCE(p.deleted, false) AS deleted
    FROM documents d LEFT JOIN paths p ON p.id = d.folder_id
    WHERE d.context_source_id IN (SELECT id FROM manuscript)
      AND d.file_type = 'image' AND d.kind = 'content'
  `);
}

/**
 * Serializing asks by id and gets the image's current path; parsing asks by
 * path, in either spelling. A deleted image keeps its last path only while
 * that path still reads back to it alone, so a chapter saved while the image
 * is gone still points at it on restore. Once a live image or another deleted
 * one holds the path, the deleted image spells as its `asset:` ref instead.
 */
function resolverFor(locations: readonly ImageLocation[]): AssetPathResolver {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const liveIdByPath = new Map<string, string>();
  const deletedIdsByPath = new Map<string, string[]>();
  for (const location of locations) {
    if (!location.deleted) liveIdByPath.set(location.path, location.id);
    else
      deletedIdsByPath.set(location.path, [
        ...(deletedIdsByPath.get(location.path) ?? []),
        location.id,
      ]);
  }
  const soleDeletedAt = (path: string) => {
    const ids = deletedIdsByPath.get(path);
    return !liveIdByPath.has(path) && ids?.length === 1 ? ids[0] : undefined;
  };
  return {
    pathForAsset(assetDocumentId) {
      const location = byId.get(assetDocumentId);
      if (!location) return null;
      if (!location.deleted) return location.path;
      return soleDeletedAt(location.path) === location.id ? location.path : null;
    },
    assetForPath(path) {
      const parsed = parseContextUri(path);
      if (!parsed.ok || parsed.value.scheme !== "manuscript" || !parsed.value.path) return null;
      const target = parsed.value.path;
      return liveIdByPath.get(target) ?? soleDeletedAt(target) ?? null;
    },
  };
}

/**
 * The paths one `within` loaded, and the doors already known to share its
 * project. `open` until its operation settles: timers and other work
 * scheduled inside inherit the scope, and must load fresh once it is over.
 */
type Scope = {
  projectId: string | null;
  resolver: AssetPathResolver;
  members: Set<string>;
  open: boolean;
};

const memberKey = (project: AssetPathProject) =>
  "projectId" in project
    ? `project:${project.projectId}`
    : "threadId" in project
      ? `thread:${project.threadId}`
      : `document:${project.documentId}`;

export function createDrizzleDocumentAssetPaths(
  db: Database,
  eventSink?: EventSink,
): DocumentAssetPaths {
  const scope = new AsyncLocalStorage<Scope>();
  const reportUnscoped = createUnscopedAssetPathObserver(eventSink);
  return {
    resolver: {
      pathForAsset(assetDocumentId) {
        const active = scope.getStore();
        if (active) return active.resolver.pathForAsset(assetDocumentId);
        reportUnscoped(assetDocumentId);
        return null;
      },
      assetForPath: (path) => scope.getStore()?.resolver.assetForPath(path) ?? null,
    },
    async within(project, operation) {
      const enclosing = scope.getStore();
      const outer = enclosing?.open ? enclosing : undefined;
      const key = memberKey(project);
      // A nested call for the same project reads the enclosing operation's paths.
      if (outer?.members.has(key)) return operation();
      const projectId = await resolveProjectId(db, project);
      // One whose project can't be found has no paths of its own to load.
      if (outer && projectId === null) return operation();
      if (outer && outer.projectId === projectId) {
        outer.members.add(key);
        return operation();
      }
      const locations = projectId ? await loadImageLocations(db, projectId) : [];
      const opened: Scope = {
        projectId,
        resolver: resolverFor(locations),
        members: new Set([key, ...(projectId ? [`project:${projectId}`] : [])]),
        open: true,
      };
      try {
        return await scope.run(opened, operation);
      } finally {
        opened.open = false;
      }
    },
  };
}
