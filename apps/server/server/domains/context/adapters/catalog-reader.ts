/** Authoritative source selection and live-tree projection for catalog readers. */
import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  contextUriFromSourceLocation,
} from "@meridian/contracts/context-uri";
import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextSources,
  projects,
  threads,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { loadJoinedFrom } from "../tree/forwards.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "../tree/tree-view.js";
import { catalogSourceAuthority, mapAuthoritativeFile } from "./catalog-file-mapper.js";
import { loadThreadFolderLabels } from "./thread-folder-labels.js";

type CatalogDb = Pick<Database, "select">;

function scopeForSource(row: {
  sourceProjectId: string | null;
  sourceWorkId: string | null;
  sourceRootThreadId: string | null;
  sourceChatThreadId: string | null;
  projectUserId: string | null;
  projectIsPersonal: boolean | null;
  workProjectId: string | null;
  sourceSlug: string;
}): CatalogScope | null {
  if (row.sourceRootThreadId && row.sourceProjectId)
    return {
      kind: "lineage",
      projectId: row.sourceProjectId,
      rootThreadId: row.sourceRootThreadId,
    };
  if (row.sourceChatThreadId && row.sourceProjectId)
    return { kind: "chat", projectId: row.sourceProjectId, chatId: row.sourceChatThreadId };
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

function catalogDispatchScopes(row: Parameters<typeof scopeForSource>[0]): readonly CatalogScope[] {
  const scope = scopeForSource(row);
  return scope ? [scope] : [];
}

export async function sourceScopes(
  db: CatalogDb,
  sourceId: string,
): Promise<readonly CatalogScope[]> {
  const [row] = await db
    .select({
      sourceProjectId: contextSources.projectId,
      sourceWorkId: contextSources.workId,
      sourceRootThreadId: contextSources.rootThreadId,
      sourceChatThreadId: contextSources.chatThreadId,
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
  return row ? catalogDispatchScopes(row) : [];
}

async function sourcesForScope(db: CatalogDb, scope: CatalogScope) {
  const conditions =
    scope.kind === "lineage"
      ? and(
          eq(contextSources.rootThreadId, scope.rootThreadId),
          eq(contextSources.projectId, scope.projectId),
          isNull(contextSources.deletedAt),
        )
      : scope.kind === "chat"
        ? and(
            eq(contextSources.chatThreadId, scope.chatId),
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
      chatThreadId: contextSources.chatThreadId,
      ownerThreadRef: threads.ref,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(
      threads,
      eq(threads.id, sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`),
    )
    .where(conditions)
    .orderBy(asc(contextSources.sortOrder), asc(contextSources.id));
}

/** The catalog is the live tree: hidden rows and folders never reach it (contract §3.4). */
export async function buildScopeEntries(
  db: CatalogDb,
  scope: CatalogScope,
): Promise<CatalogEntry[]> {
  if (scope.kind !== "user") {
    const [activeProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, scope.projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!activeProject) return [];
    if (scope.kind === "work") {
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
      if (!visibleWork) return [];
    }
  }
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
  const sourceIds = sourceRows.map((row) => row.id as ContextSourceId);
  const vf = visibleFolders(LIVE_TREE);
  const vd = visibleDocuments(LIVE_TREE);
  const folderRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            id: vf.id,
            contextSourceId: vf.contextSourceId,
            parentId: vf.parentId,
            name: vf.name,
            description: vf.description,
            sortOrder: vf.sortOrder,
            createdAt: vf.createdAt,
            updatedAt: vf.updatedAt,
          })
          .from(vf)
          .where(inArray(vf.contextSourceId, sourceIds));
  const documentRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            id: vd.id,
            contextSourceId: vd.contextSourceId,
            folderId: vd.folderId,
            name: vd.name,
            extension: vd.extension,
            fileType: vd.fileType,
            storageUrl: vd.storageUrl,
            mimeType: vd.mimeType,
            metadata: vd.metadata,
            provisionalName: vd.provisionalName,
          })
          .from(vd)
          .where(inArray(vd.contextSourceId, sourceIds));
  const joinedFrom = await loadJoinedFrom(
    db as Database,
    documentRows.map((document) => document.id as DocumentId),
  );
  const chatSourceIds = new Set(sourceRows.filter((r) => r.chatThreadId !== null).map((r) => r.id));
  const chatDocumentIds = documentRows
    .filter((document) => chatSourceIds.has(document.contextSourceId))
    .map((document) => document.id);
  // `used` is the intake's `already_used` rule: a sent message consumed the upload.
  const uploadFacts = new Map(
    chatDocumentIds.length === 0
      ? []
      : (
          await db
            .select({
              documentId: uploadIntakes.documentId,
              createdAt: uploadIntakes.createdAt,
              consumedAt: uploadIntakes.consumedAt,
              intakeId: uploadIntakes.intakeId,
              locationRevision: uploadIntakes.locationRevision,
            })
            .from(uploadIntakes)
            .where(
              and(
                inArray(uploadIntakes.documentId, chatDocumentIds as DocumentId[]),
                ne(uploadIntakes.state, "deleted"),
              ),
            )
        ).map((row) => [
          row.documentId as string,
          {
            attachedAt: row.createdAt,
            consumed: row.consumedAt !== null,
            intakeId: row.intakeId,
            locationRevision: row.locationRevision,
          },
        ]),
  );
  const folderLabels = await loadThreadFolderLabels(
    db,
    folderRows.map((row) => row.id),
  );
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
  const entries: CatalogEntry[] = [];
  for (const source of sourceRows) {
    const scheme = source.slug as ContextUriScheme;
    const authority = catalogSourceAuthority(
      scheme,
      source.workId,
      source.workSlug,
      source.ownerThreadRef,
      source.chatThreadId !== null,
    );
    entries.push({
      kind: "source",
      entryId: source.id,
      scope,
      scheme,
      name: source.name,
      uri: contextUriFromSourceLocation(scheme, "", authority),
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
        ...(folderLabels.has(folder.id) ? { displayName: folderLabels.get(folder.id) } : {}),
        path,
        uri: contextUriFromSourceLocation(scheme, path.join("/"), authority),
        hasChildren: (childCounts.get(folder.id) ?? 0) > 0,
      });
    }
    for (const document of documentRows.filter((item) => item.contextSourceId === source.id)) {
      const parentPath = pathForFolder(document.folderId, source.id);
      if (!parentPath) continue;
      entries.push(
        mapAuthoritativeFile({
          document: { ...document, joinedFrom: joinedFrom.get(document.id as DocumentId) },
          scope,
          observationVersion,
          scheme,
          workId: source.workId,
          workSlug: source.workSlug,
          ownerThreadRef: source.ownerThreadRef,
          chatOwned: source.chatThreadId !== null,
          upload: uploadFacts.get(document.id),
          parentPath,
        }),
      );
    }
  }
  if (scope.kind === "project") {
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
      const workSlug = work.slug === null ? null : decodeWorkSlug(work.slug);
      if (work.slug !== null && !workSlug) continue;
      entries.push({
        kind: "authority",
        entryId: work.id,
        scope,
        authority: { workId: work.id, workSlug },
        name: work.name,
        available: work.deletedAt === null && work.archivedAt === null,
        entityRevision: String(work.entityRevision),
      });
    }
  }
  return entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
}
