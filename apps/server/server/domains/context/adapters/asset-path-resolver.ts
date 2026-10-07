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

function projectHost(project: AssetPathProject) {
  if ("projectId" in project) {
    return isUuid(project.projectId) ? sql`SELECT ${project.projectId}::uuid AS project_id` : null;
  }
  if ("threadId" in project) {
    return isUuid(project.threadId)
      ? sql`SELECT t.project_id FROM threads t WHERE t.id = ${project.threadId}`
      : null;
  }
  if (!isUuid(project.documentId)) return null;
  return sql`
    SELECT COALESCE(cs.project_id, w.project_id) AS project_id
    FROM documents d
    JOIN context_sources cs ON cs.id = d.context_source_id
    LEFT JOIN works w ON w.id = cs.work_id
    WHERE d.id = ${project.documentId}`;
}

/**
 * Every image in the project's manuscript, wherever it sits,
 * including deleted ones at the location they were deleted from. Paths are
 * manuscript-root-relative: the bare spelling `parseContextUri` reads as
 * `manuscript://`, and the one figure upload has always written.
 */
async function loadImageLocations(
  db: Database,
  project: AssetPathProject,
): Promise<ImageLocation[]> {
  const host = projectHost(project);
  if (!host) return [];
  return currentDrizzleDb(db).execute<ImageLocation>(sql`
    WITH RECURSIVE host AS (${host}),
    manuscript AS (
      SELECT cs.id FROM context_sources cs JOIN host ON cs.project_id = host.project_id
      WHERE cs.slug = 'manuscript' AND cs.work_id IS NULL
    ),
    paths AS (
      SELECT f.id, f.name AS path, f.deleted_at IS NOT NULL AS deleted
      FROM folders f
      WHERE f.parent_id IS NULL AND f.context_source_id IN (SELECT id FROM manuscript)
      UNION ALL
      SELECT f.id, p.path || '/' || f.name, p.deleted OR f.deleted_at IS NOT NULL
      FROM folders f JOIN paths p ON f.parent_id = p.id
    )
    SELECT d.id::text AS id,
      COALESCE(p.path || '/', '') || d.name ||
        CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS path,
      d.deleted_at IS NOT NULL OR COALESCE(p.deleted, false) AS deleted
    FROM documents d LEFT JOIN paths p ON p.id = d.folder_id
    WHERE d.context_source_id IN (SELECT id FROM manuscript)
      AND d.kind = 'content' AND d.file_type = 'image'
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

export function createDrizzleDocumentAssetPaths(
  db: Database,
  eventSink?: EventSink,
): DocumentAssetPaths {
  const scope = new AsyncLocalStorage<AssetPathResolver>();
  const reportUnscoped = createUnscopedAssetPathObserver(eventSink);
  return {
    resolver: {
      pathForAsset(assetDocumentId) {
        const resolver = scope.getStore();
        if (resolver) return resolver.pathForAsset(assetDocumentId);
        reportUnscoped(assetDocumentId);
        return null;
      },
      assetForPath: (path) => scope.getStore()?.assetForPath(path) ?? null,
    },
    async within(project, operation) {
      return scope.run(resolverFor(await loadImageLocations(db, project)), operation);
    },
  };
}
