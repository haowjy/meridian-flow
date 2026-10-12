/** Builds authoritative catalog entries for one scope from live sources, folders, documents, and Works. */
import { type ContextUriScheme, canonicalContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextSources,
  documents,
  folders,
  projects,
  threads,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  type ManifestMembershipResolver,
  resolveCatalogDocumentMembership,
} from "../visible-document-membership.js";
import { catalogSourceAuthority, mapAuthoritativeFile } from "./catalog-file-mapper.js";

export type CatalogDb = Pick<Database, "delete" | "insert" | "select" | "update">;

/**
 * Which part of a scope a refresh reconciles. `scope` rebuilds every entry;
 * `documents` rebuilds only the named file entries and leaves the rest of the
 * cached scope untouched.
 */
export type CatalogRefreshSelection =
  | { kind: "scope" }
  | { kind: "documents"; documentIds: readonly string[] };

export const FULL_SCOPE_SELECTION: CatalogRefreshSelection = { kind: "scope" };

type SourceScopeRow = {
  sourceProjectId: string | null;
  sourceWorkId: string | null;
  sourceRootThreadId: string | null;
  projectUserId: string | null;
  projectIsPersonal: boolean | null;
  workProjectId: string | null;
  sourceSlug: string;
};

type WorkAuthorityRow = {
  id: string;
  slug: string | null;
  name: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  entityRevision: number | bigint;
};

function scopeForSource(row: SourceScopeRow): CatalogScope | null {
  if (row.sourceRootThreadId && row.sourceProjectId)
    return {
      kind: "lineage",
      projectId: row.sourceProjectId,
      rootThreadId: row.sourceRootThreadId,
    };
  if (row.sourceWorkId && row.workProjectId) {
    return { kind: "work", projectId: row.workProjectId, workId: row.sourceWorkId };
  }
  if (!row.sourceProjectId) return null;
  if (row.sourceSlug === "user" && row.projectIsPersonal && row.projectUserId) {
    return { kind: "user", userId: row.projectUserId };
  }
  if (row.sourceSlug === "scratch" || row.sourceSlug === "uploads") return null;
  return { kind: "project", projectId: row.sourceProjectId };
}

/** Catalog scopes that list a source; scratch and uploads sources have none. */
export async function sourceScopes(
  db: CatalogDb,
  sourceId: string,
): Promise<readonly CatalogScope[]> {
  const [row] = await db
    .select({
      sourceProjectId: contextSources.projectId,
      sourceWorkId: contextSources.workId,
      sourceRootThreadId: contextSources.rootThreadId,
      sourceSlug: contextSources.slug,
      projectUserId: projects.userId,
      projectIsPersonal: projects.isPersonal,
      workProjectId: works.projectId,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(eq(contextSources.id, sourceId as never))
    .limit(1);
  const scope = row ? scopeForSource(row) : null;
  return scope ? [scope] : [];
}

async function sourcesForScope(db: CatalogDb, scope: CatalogScope) {
  const conditions =
    scope.kind === "lineage"
      ? and(
          eq(contextSources.rootThreadId, scope.rootThreadId),
          eq(contextSources.projectId, scope.projectId),
          isNull(contextSources.deletedAt),
        )
      : scope.kind === "work"
        ? and(eq(contextSources.workId, scope.workId), isNull(contextSources.deletedAt))
        : scope.kind === "user"
          ? and(
              eq(projects.userId, scope.userId),
              eq(projects.isPersonal, true),
              eq(contextSources.slug, "user"),
              isNull(projects.deletedAt),
              isNull(contextSources.deletedAt),
            )
          : and(
              eq(contextSources.projectId, scope.projectId),
              inArray(contextSources.slug, ["manuscript", "kb", "unfiled"]),
              isNull(contextSources.deletedAt),
            );
  return db
    .select({
      id: contextSources.id,
      name: contextSources.name,
      slug: contextSources.slug,
      workId: contextSources.workId,
      workSlug: works.slug,
      rootThreadRef: threads.ref,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(threads, eq(threads.id, contextSources.rootThreadId))
    .where(conditions)
    .orderBy(asc(contextSources.sortOrder), asc(contextSources.id));
}

/** Project-scope authority entry for a Work; null when its stored slug is undecodable. */
export function workAuthorityEntry(
  scope: Extract<CatalogScope, { kind: "project" }>,
  work: WorkAuthorityRow,
): CatalogEntry | null {
  const workSlug = work.slug === null ? null : decodeWorkSlug(work.slug);
  if (work.slug !== null && !workSlug) return null;
  return {
    kind: "authority",
    entryId: work.id,
    scope,
    authority: { workId: work.id, workSlug },
    name: work.name,
    available: work.deletedAt === null && work.archivedAt === null,
    entityRevision: String(work.entityRevision),
  };
}

async function scopeIsLive(db: CatalogDb, scope: CatalogScope): Promise<boolean> {
  if (scope.kind === "user") return true;
  const [activeProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!activeProject) return false;
  if (scope.kind !== "work") return true;
  const [visibleWork] = await db
    .select({ id: works.id })
    .from(works)
    .where(
      and(
        eq(works.id, scope.workId),
        eq(works.projectId, scope.projectId),
        isNull(works.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(visibleWork);
}

/**
 * Authoritative entries for the selected part of a scope, sorted by entry ID.
 * A `documents` selection yields only those file entries.
 */
export async function buildAuthoritativeEntries(
  db: CatalogDb,
  scope: CatalogScope,
  selection: CatalogRefreshSelection,
  manifestMembership?: ManifestMembershipResolver,
): Promise<CatalogEntry[]> {
  if (!(await scopeIsLive(db, scope))) return [];
  const [namespaceHead] = await db
    .select({ version: contextAvailabilityHeads.namespaceGeneration })
    .from(contextAvailabilityHeads)
    .where(
      eq(
        contextAvailabilityHeads.authorityKey,
        scope.kind === "user" ? `user:${scope.userId}` : `project:${scope.projectId}`,
      ),
    );
  const observationVersion = String(namespaceHead?.version ?? 0n);
  const sourceRows = await sourcesForScope(db, scope);
  const sourceIds = sourceRows.map((row) => row.id);
  const folderRows =
    sourceIds.length === 0
      ? []
      : await db
          .select()
          .from(folders)
          .where(and(inArray(folders.contextSourceId, sourceIds), isNull(folders.deletedAt)));
  let documentRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            id: documents.id,
            contextSourceId: documents.contextSourceId,
            folderId: documents.folderId,
            name: documents.name,
            extension: documents.extension,
            fileType: documents.fileType,
            storageUrl: documents.storageUrl,
            mimeType: documents.mimeType,
            metadata: documents.metadata,
            provisionalName: documents.provisionalName,
          })
          .from(documents)
          .where(
            and(
              inArray(documents.contextSourceId, sourceIds),
              eq(documents.kind, "content"),
              selection.kind === "documents"
                ? inArray(documents.id, [...selection.documentIds])
                : undefined,
              isNull(documents.deletedAt),
            ),
          );
  if (scope.kind === "project" && manifestMembership) {
    const manuscriptSourceIds = new Set(
      sourceRows.filter((source) => source.slug === "manuscript").map((source) => source.id),
    );
    if (manuscriptSourceIds.size > 0) {
      const visibleMembership = await resolveCatalogDocumentMembership({
        projectId: scope.projectId,
        resolver: manifestMembership,
      });
      if (visibleMembership) {
        documentRows = documentRows.filter(
          (document) =>
            !manuscriptSourceIds.has(document.contextSourceId) ||
            visibleMembership.has(document.id),
        );
      }
    }
  }
  const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));
  const childCounts = new Map<string, number>();
  for (const folder of folderRows) {
    const parent = folder.parentId ?? folder.contextSourceId;
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  for (const document of documentRows) {
    const parent = document.folderId ?? document.contextSourceId;
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  const pathForFolder = (folderId: string | null, sourceId: string): string[] | null => {
    const result: string[] = [];
    const visited = new Set<string>();
    let current = folderId;
    while (current) {
      if (visited.has(current)) return null;
      visited.add(current);
      const folder = foldersById.get(current);
      if (!folder || folder.contextSourceId !== sourceId) return null;
      result.unshift(folder.name);
      current = folder.parentId;
    }
    return result;
  };
  const includeStructure = selection.kind === "scope";
  const entries: CatalogEntry[] = [];
  for (const source of sourceRows) {
    const scheme = source.slug as ContextUriScheme;
    const authority = catalogSourceAuthority(
      scheme,
      source.workId,
      source.workSlug,
      source.rootThreadRef,
    );
    if (includeStructure) {
      entries.push({
        kind: "source",
        entryId: source.id,
        scope,
        scheme,
        name: source.name,
        uri: canonicalContextUri(scheme, "", authority),
      });
      for (const folder of folderRows.filter((item) => item.contextSourceId === source.id)) {
        const path = pathForFolder(folder.id, source.id);
        if (!path) continue;
        entries.push({
          kind: "folder",
          observationVersion,
          entryId: folder.id,
          scope,
          sourceId: source.id,
          parentId: folder.parentId ?? source.id,
          name: folder.name,
          path,
          uri: canonicalContextUri(scheme, path.join("/"), authority),
          hasChildren: (childCounts.get(folder.id) ?? 0) > 0,
        });
      }
    }
    for (const document of documentRows.filter((item) => item.contextSourceId === source.id)) {
      const parentPath = pathForFolder(document.folderId, source.id);
      if (!parentPath) continue;
      entries.push(
        mapAuthoritativeFile({
          document,
          scope,
          observationVersion,
          scheme,
          workId: source.workId,
          workSlug: source.workSlug,
          rootThreadRef: source.rootThreadRef,
          parentPath,
        }),
      );
    }
  }
  if (includeStructure && scope.kind === "project") {
    const workRows = await db
      .select({
        id: works.id,
        slug: works.slug,
        name: works.name,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
        entityRevision: works.entityRevision,
      })
      .from(works)
      .where(eq(works.projectId, scope.projectId));
    for (const work of workRows) {
      const entry = workAuthorityEntry(scope, work);
      if (entry) entries.push(entry);
    }
  }
  return entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
}
