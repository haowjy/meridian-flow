/** Drizzle project-final identity lookup and global availability watermarks. */

import { randomUUID } from "node:crypto";
import type { DocumentId, ProjectId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  canonicalContextUri,
  isContextUriScheme,
} from "@meridian/contracts/context-uri";
import type {
  CatalogScope,
  ProjectContextAuthority,
  ProjectContextFolderResolution,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { PROJECT_CONTEXT_AVAILABILITY_MAX_IDS } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextSources,
  documents as documentsTable,
  projects,
  threads,
  works,
} from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type {
  HeldContextNode,
  ProjectContextAvailabilityPort,
} from "../ports/project-context-availability.js";
import { type FolderLink, loadFolderChains, placedNodesSql } from "../tree/tree-addresses.js";
import { LIVE_TREE, type TreeView } from "../tree/tree-view.js";
import {
  type CatalogFileRow,
  mapAuthoritativeFile,
  sourceAuthority,
} from "./context-file-entry.js";

type AvailabilityRow = {
  document: CatalogFileRow & { deleted?: boolean };
  source: typeof contextSources.$inferSelect | null;
  sourceProject: typeof projects.$inferSelect | null;
  work: typeof works.$inferSelect | null;
  ownerThreadRef?: string | null;
};
type AvailabilityIdentity = {
  scope: CatalogScope;
  authority: ProjectContextAuthority;
  scheme: ContextUriScheme;
  generation: string;
  parentPath: string[];
};
type IdentityClassification =
  | { kind: "not-visible" }
  | { kind: "inconsistent" }
  | { kind: "valid"; identity: AvailabilityIdentity };

const WORK_SCHEMES = new Set<ContextUriScheme>(["scratch", "uploads"]);

type IdentityFolder = FolderLink;

/** Requested parent folders and the ancestors needed to spell them, in the view. */
async function loadIdentityFolderClosure(
  db: Database,
  view: TreeView,
  folderIds: readonly string[],
): Promise<IdentityFolder[]> {
  const chains = await loadFolderChains(db, folderIds as never, view);
  return [...new Map([...chains.values()].flat().map((folder) => [folder.id, folder])).values()];
}

export function classifyAuthoritativeIdentity(input: {
  row: AvailabilityRow;
  requestProjectId: string;
  actorUserId: string;
  projectGeneration: string;
  checkedGeneration: string;
  foldersById: ReadonlyMap<string, IdentityFolder>;
}): IdentityClassification {
  return classifySourceIdentity({
    ...input,
    row: {
      ...input.row,
      node: {
        parentId: input.row.document.folderId,
        deleted: input.row.document.deleted ?? false,
      },
    },
  });
}

function classifySourceIdentity(input: {
  row: Omit<AvailabilityRow, "document"> & {
    node: { parentId: string | null; deleted: boolean };
  };
  requestProjectId: string;
  actorUserId: string;
  projectGeneration: string;
  checkedGeneration: string;
  foldersById: ReadonlyMap<string, IdentityFolder>;
}): IdentityClassification {
  const { node, source, sourceProject, work } = input.row;
  const rawProjectIsRequested = source?.projectId === input.requestProjectId;
  const rawWorkIsRequested = work?.projectId === input.requestProjectId;
  const isActorUserSource =
    source?.slug === "user" &&
    sourceProject?.isPersonal === true &&
    sourceProject.userId === input.actorUserId;
  if (!rawProjectIsRequested && !rawWorkIsRequested && !isActorUserSource) {
    return { kind: "not-visible" };
  }
  if (!source || !isContextUriScheme(source.slug)) {
    return { kind: "inconsistent" };
  }
  const scheme = source.slug;
  const isWorkScheme = WORK_SCHEMES.has(scheme);
  const hasLineageOwnership =
    source.scope === "lineage" &&
    source.rootThreadId !== null &&
    source.projectId !== null &&
    source.workId === null &&
    scheme === "scratch" &&
    !!input.row.ownerThreadRef;
  const hasChatOwnership =
    source.scope === "chat" &&
    source.chatThreadId !== null &&
    source.projectId !== null &&
    source.workId === null &&
    scheme === "uploads";
  const hasWorkOwnership = source.scope === "work" && source.workId !== null;
  const hasProjectOwnership = source.scope === "project" && source.projectId !== null;
  const ownershipKinds = [
    hasLineageOwnership,
    hasChatOwnership,
    hasWorkOwnership,
    hasProjectOwnership,
  ].filter(Boolean).length;
  if (
    ownershipKinds !== 1 ||
    (hasWorkOwnership && !isWorkScheme) ||
    (source.workId !== null) !== hasWorkOwnership ||
    (source.projectId !== null) !==
      (hasProjectOwnership || hasLineageOwnership || hasChatOwnership) ||
    (hasWorkOwnership && (!work || work.id !== source.workId)) ||
    (hasProjectOwnership && (!sourceProject || sourceProject.id !== source.projectId)) ||
    (scheme === "user" &&
      (!sourceProject?.isPersonal || sourceProject.userId !== input.actorUserId))
  ) {
    return { kind: "inconsistent" };
  }

  let scope: CatalogScope;
  let authority: ProjectContextAuthority;
  let generation = input.projectGeneration;
  if (hasLineageOwnership && source.projectId && source.rootThreadId && input.row.ownerThreadRef) {
    scope = { kind: "lineage", projectId: source.projectId, rootThreadId: source.rootThreadId };
    authority = {
      kind: "lineage",
      projectId: source.projectId,
      rootThreadId: source.rootThreadId,
      rootThreadRef: input.row.ownerThreadRef,
    };
  } else if (hasChatOwnership && source.projectId && source.chatThreadId) {
    scope = { kind: "chat", projectId: source.projectId, chatId: source.chatThreadId };
    authority = {
      kind: "chat",
      projectId: source.projectId,
      chatId: source.chatThreadId,
      chatRef: input.row.ownerThreadRef ?? null,
    };
  } else if (hasWorkOwnership) {
    if (!work || work.projectId !== input.requestProjectId) {
      return { kind: "inconsistent" };
    }
    const workHandle = work.isNoWork ? null : decodeWorkHandle(work.handle);
    if (!work.isNoWork && !workHandle) {
      return { kind: "inconsistent" };
    }
    scope = { kind: "work", projectId: input.requestProjectId, workId: work.id } as never;
    authority = {
      kind: "work",
      projectId: input.requestProjectId,
      workId: work.id,
      workHandle,
    } as never;
  } else if (isActorUserSource) {
    scope = { kind: "user", userId: input.actorUserId } as never;
    authority = { kind: "user", userId: input.actorUserId } as never;
    generation = input.checkedGeneration;
  } else if (isWorkScheme) {
    return { kind: "inconsistent" };
  } else {
    scope = { kind: "project", projectId: input.requestProjectId } as never;
    authority = { kind: "project", projectId: input.requestProjectId } as never;
  }

  const parentPath: string[] = [];
  const visited = new Set<string>();
  let folderId = node.parentId;
  while (folderId) {
    if (visited.has(folderId)) return { kind: "inconsistent" };
    visited.add(folderId);
    const folder = input.foldersById.get(folderId);
    if (!folder || (!node.deleted && source.deletedAt === null && folder.deleted)) {
      return { kind: "inconsistent" };
    }
    parentPath.unshift(folder.name);
    folderId = folder.parentId;
  }
  return { kind: "valid", identity: { scope, authority, scheme, generation, parentPath } };
}

export function normalizeAvailabilityDocumentIds(documentIds: readonly string[]): string[] {
  const ids = [...new Set(documentIds)];
  if (ids.length > PROJECT_CONTEXT_AVAILABILITY_MAX_IDS) {
    throw new RangeError(
      `documentIds must contain at most ${PROJECT_CONTEXT_AVAILABILITY_MAX_IDS} distinct IDs`,
    );
  }
  return ids;
}

function projectKey(projectId: string) {
  return `project:${projectId}`;
}
function userKey(userId: string) {
  return `user:${userId}`;
}

type SourceFacts = {
  source: typeof contextSources.$inferSelect;
  sourceProject: typeof projects.$inferSelect | null;
  work: typeof works.$inferSelect | null;
  ownerThreadRef: string | null;
};

/** The sources, their owners and the thread whose ref spells them, by source id. */
async function loadSourceFacts(
  tx: Database,
  sourceIds: readonly string[],
): Promise<Map<string, SourceFacts>> {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      source: contextSources,
      sourceProject: projects,
      work: works,
      ownerThreadRef: threads.ref,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(
      threads,
      eq(threads.id, sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`),
    )
    .where(inArray(contextSources.id, ids as never));
  return new Map(rows.map((row) => [row.source.id, row]));
}

type PlacedRow = {
  id: string;
  kind: "document" | "folder";
  contextSourceId: string;
  parentId: string | null;
  name: string;
  extension: string;
  fileType: string | null;
  rank: string;
  locationVersion: string;
  deleted: boolean;
};

/** The nodes among `ids` the view places (deleted ones too), with the facts of their sources. */
async function loadPlacedRows(tx: Database, view: TreeView, ids: readonly string[]) {
  const wanted = [...new Set(ids)].filter(isUuid);
  const placed =
    wanted.length === 0
      ? []
      : await tx.execute<PlacedRow>(sql`
          SELECT n.id::text AS id, n.kind, n.context_source_id::text AS "contextSourceId",
            n.parent_id::text AS "parentId", n.name, n.extension, n.file_type AS "fileType",
            n.rank, n.location_version::text AS "locationVersion", n.deleted
          FROM ${placedNodesSql(view)} n
          WHERE n.id IN (${sql.join(
            wanted.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`);
  const documentIds = placed.filter((row) => row.kind === "document").map((row) => row.id);
  const stored = new Map(
    (documentIds.length === 0
      ? []
      : await tx
          .select({
            id: documentsTable.id,
            storageUrl: documentsTable.storageUrl,
            mimeType: documentsTable.mimeType,
            metadata: documentsTable.metadata,
          })
          .from(documentsTable)
          .where(inArray(documentsTable.id, documentIds as never))
    ).map((row) => [row.id as string, row]),
  );
  const facts = await loadSourceFacts(
    tx,
    placed.map((row) => row.contextSourceId),
  );
  const documents: (SourceFacts & { document: CatalogFileRow & { deleted: boolean } })[] = [];
  const folders: (SourceFacts & {
    folder: {
      id: string;
      contextSourceId: string;
      parentId: string | null;
      name: string;
      deleted: boolean;
    };
  })[] = [];
  for (const row of placed) {
    const source = facts.get(row.contextSourceId);
    if (!source) continue;
    if (row.kind === "folder") {
      folders.push({
        ...source,
        folder: {
          id: row.id,
          contextSourceId: row.contextSourceId,
          parentId: row.parentId,
          name: row.name,
          deleted: row.deleted,
        },
      });
      continue;
    }
    const content = stored.get(row.id);
    if (!content || !row.fileType) continue;
    documents.push({
      ...source,
      document: {
        id: row.id,
        contextSourceId: row.contextSourceId,
        folderId: row.parentId,
        name: row.name,
        extension: row.extension,
        fileType: row.fileType,
        storageUrl: content.storageUrl,
        mimeType: content.mimeType,
        metadata: content.metadata,
        rank: row.rank,
        locationVersion: BigInt(row.locationVersion),
        deleted: row.deleted,
      },
    });
  }
  return { documents, folders };
}

export function createDrizzleProjectContextAvailability(
  db: Database,
  eventSink?: EventSink,
): ProjectContextAvailabilityPort {
  return {
    async lookup(input, actor) {
      const view = input.view ?? LIVE_TREE;
      const ids = normalizeAvailabilityDocumentIds(input.documentIds);
      const folderIds = normalizeAvailabilityDocumentIds(input.folderIds ?? []);
      if (ids.length + folderIds.length > PROJECT_CONTEXT_AVAILABILITY_MAX_IDS)
        throw new RangeError("Availability lookup exceeds ID limit");
      return runInRootDrizzleTransaction(
        db,
        async () => {
          const tx = currentDrizzleDb(db) as Database;
          const [requestProject] = await tx
            .select({ id: projects.id, userId: projects.userId, deletedAt: projects.deletedAt })
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .limit(1);
          if (!requestProject || requestProject.userId !== actor.userId) {
            throw new Error("Project not found");
          }
          const headRows = await tx
            .select()
            .from(contextAvailabilityHeads)
            .where(
              inArray(contextAvailabilityHeads.authorityKey, [
                projectKey(input.projectId),
                userKey(actor.userId),
              ]),
            );
          const head = new Map(headRows.map((row) => [row.authorityKey, row.generation]));
          const namespaceHead = new Map(
            headRows.map((row) => [row.authorityKey, row.namespaceGeneration]),
          );
          const namespaceVersion = (scope: CatalogScope) =>
            String(
              namespaceHead.get(
                scope.kind === "user" ? userKey(scope.userId) : projectKey(scope.projectId),
              ) ?? 0n,
            );
          const projectGeneration = head.get(projectKey(input.projectId)) ?? 0n;
          const checkedGeneration = String(
            [projectGeneration, head.get(userKey(actor.userId)) ?? 0n].reduce((a, b) =>
              a > b ? a : b,
            ),
          );
          if (ids.length === 0 && folderIds.length === 0) {
            return { projectId: input.projectId, resolutionId: randomUUID(), resolutions: [] };
          }
          const placed = await loadPlacedRows(tx, view, [...ids, ...folderIds]);
          const rows = placed.documents.map((row) => row);
          const requestedFolders = placed.folders;
          const byId = new Map(rows.map((row) => [row.document.id, row]));
          const folderRows = await loadIdentityFolderClosure(tx, view, [
            ...rows.flatMap((row) => (row.document.folderId ? [row.document.folderId] : [])),
            ...requestedFolders.map((row) => row.folder.id),
          ]);
          const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));

          const resolutions: ProjectContextIdentityResolution[] = ids.map((documentId) => {
            const row = byId.get(documentId);
            if (!row) return { kind: "not-visible", documentId, checkedGeneration } as never;
            const { document, source, sourceProject, work } = row;
            const indeterminate = (): ProjectContextIdentityResolution => {
              if (eventSink) {
                emitEvent(eventSink, {
                  level: "error",
                  source: "context-availability",
                  name: "ProjectContextIdentityInconsistent",
                  payload: { documentId, projectId: input.projectId },
                });
              }
              return {
                kind: "indeterminate",
                documentId,
                checkedGeneration,
                reason: "identity_inconsistent",
              } as never;
            };
            const classification = classifyAuthoritativeIdentity({
              row,
              requestProjectId: input.projectId,
              actorUserId: actor.userId,
              projectGeneration: String(projectGeneration),
              checkedGeneration,
              foldersById,
            });
            if (classification.kind === "not-visible") {
              return { kind: "not-visible", documentId, checkedGeneration } as never;
            }
            if (classification.kind === "inconsistent") return indeterminate();
            const { scope, authority, scheme, generation, parentPath } = classification.identity;
            // This site has to name the liveness fact that failed, so it classifies rather
            // than filters. A node in Trash, or deleted in this Work's tree, is deleted even
            // when its authority hides.
            if (document.deleted) {
              return {
                kind: "deleted",
                documentId,
                generation,
                observationVersion: namespaceVersion(scope),
                lastAuthority: authority,
              };
            }
            if (requestProject.deletedAt || sourceProject?.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "project_deleted",
              } as never;
            }
            if (work?.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "work_deleted",
              } as never;
            }
            // Lineage sources hide when their last chat is trashed and reopen on restore.
            // That revokes authority; it does not delete the documents they still own.
            if (source?.scope === "lineage" && source.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "lineage_hidden",
              };
            }
            // A trashed chat hides its uploads the same way, and its restore reopens them.
            if (source?.scope === "chat" && source.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "chat_hidden",
              };
            }
            if (source?.deletedAt) {
              return {
                kind: "deleted",
                documentId,
                generation,
                observationVersion: namespaceVersion(scope),
                lastAuthority: authority,
              } as never;
            }
            try {
              return {
                kind: "available",
                documentId,
                generation,
                authority,
                entry: mapAuthoritativeFile({
                  document,
                  scope,
                  observationVersion: namespaceVersion(scope),
                  scheme,
                  workId: work?.id ?? null,
                  workHandle: work && !work.isNoWork ? work.handle : null,
                  parentPath,
                  ownerThreadRef: row.ownerThreadRef,
                  chatOwned: source?.scope === "chat",
                }),
              } as never;
            } catch {
              return indeterminate();
            }
          });
          const folderById = new Map(requestedFolders.map((row) => [row.folder.id, row]));
          const folderResolutions: ProjectContextFolderResolution[] = folderIds.map((folderId) => {
            const row = folderById.get(folderId);
            if (!row) return { folderId, kind: "not-visible", checkedGeneration };
            const classification = classifySourceIdentity({
              row: {
                ...row,
                node: { parentId: row.folder.parentId, deleted: row.folder.deleted },
              },
              requestProjectId: input.projectId,
              actorUserId: actor.userId,
              projectGeneration: String(projectGeneration),
              checkedGeneration,
              foldersById,
            });
            if (classification.kind !== "valid")
              return {
                folderId,
                kind: classification.kind === "not-visible" ? "not-visible" : "indeterminate",
                checkedGeneration,
              };
            const { scope, scheme, generation, parentPath } = classification.identity;
            // Work/lineage unavailability is not deletion.
            if (row.folder.deleted)
              return {
                folderId,
                kind: "deleted",
                generation,
                observationVersion: namespaceVersion(scope),
              };
            if (
              requestProject.deletedAt ||
              row.sourceProject?.deletedAt ||
              row.work?.deletedAt ||
              row.source?.deletedAt
            )
              return { folderId, kind: "authority-unavailable", checkedGeneration };
            const path = [...parentPath, row.folder.name];
            return {
              folderId,
              kind: "available",
              generation,
              entry: {
                kind: "folder",
                observationVersion: namespaceVersion(scope),
                entryId: row.folder.id,
                sourceId: row.folder.contextSourceId,
                parentId: row.folder.parentId ?? row.folder.contextSourceId,
                scope,
                name: row.folder.name,
                path,
                uri: canonicalContextUri(
                  scheme,
                  path.join("/"),
                  sourceAuthority(
                    scheme,
                    row.work?.id ?? null,
                    row.work && !row.work.isNoWork ? row.work.handle : null,
                    row.ownerThreadRef,
                    row.source?.scope === "chat",
                  ),
                ),
                hasChildren: true,
              },
            };
          });
          return {
            projectId: input.projectId,
            resolutionId: randomUUID(),
            resolutions,
            ...(input.folderIds !== undefined ? { folderResolutions } : {}),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    held(input, actor) {
      return resolveHeldContextNode({
        db,
        projectId: input.projectId,
        userId: actor.userId,
        node: input.node,
      });
    },

    serializeCreate(entryId, create) {
      // The transaction ends with the create, so the lock outlives its claim's commit.
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`create-entry:${entryId}`}, 0::bigint))`,
        );
        return create();
      });
    },
  };
}

/** Resolve an active live folder inside the caller's transaction, without a new snapshot. */
export async function resolveActiveFolderUri(
  db: Database,
  projectId: string,
  userId: string,
  folderId: string,
): Promise<string | null> {
  const tx = currentDrizzleDb(db) as Database;
  const [row] = (await loadPlacedRows(tx, LIVE_TREE, [folderId])).folders;
  if (
    !row?.source ||
    row.folder.deleted ||
    row.source.deletedAt ||
    row.sourceProject?.deletedAt ||
    row.work?.deletedAt ||
    row.work?.archivedAt
  )
    return null;
  const ancestors = await loadIdentityFolderClosure(tx, LIVE_TREE, [folderId]);
  const classification = classifySourceIdentity({
    row: { ...row, node: { parentId: row.folder.parentId, deleted: false } },
    requestProjectId: projectId,
    actorUserId: userId,
    projectGeneration: "0",
    checkedGeneration: "0",
    foldersById: new Map(ancestors.map((folder) => [folder.id, folder])),
  });
  if (classification.kind !== "valid") return null;
  return canonicalContextUri(
    classification.identity.scheme,
    [...classification.identity.parentPath, row.folder.name].join("/"),
    sourceAuthority(
      classification.identity.scheme,
      row.work?.id ?? null,
      row.work && !row.work.isNoWork ? row.work.handle : null,
      row.ownerThreadRef,
      row.source.scope === "chat",
    ),
  );
}

/** Whether this project (or the writer's own User area) holds the row's source. */
function heldInProject(row: SourceFacts, projectId: string, userId: string): boolean {
  return (
    row.source.projectId === projectId ||
    row.work?.projectId === projectId ||
    (row.source.slug === "user" &&
      row.sourceProject?.isPersonal === true &&
      row.sourceProject.userId === userId)
  );
}

/**
 * The address this project holds `id` at in live, in Trash included, read from the node and its
 * source rather than through a Work authority. Null when the project holds no such node (a node
 * in no live view is held by no one); `unreachable` when it holds one no live address can name
 * (in Trash, or an inconsistent identity).
 */
async function resolveHeldContextNode(input: {
  db: Database;
  projectId: ProjectId;
  userId: string;
  node: { kind: "document"; id: DocumentId } | { kind: "folder"; id: string };
}): Promise<HeldContextNode | null> {
  if (!isUuid(input.node.id)) return null;
  const tx = currentDrizzleDb(input.db) as Database;
  const placed = await loadPlacedRows(tx, LIVE_TREE, [input.node.id]);
  const found =
    input.node.kind === "document"
      ? placed.documents.map((row) => ({
          ...row,
          name: row.document.name,
          parentId: row.document.folderId,
          deleted: row.document.deleted,
        }))[0]
      : placed.folders.map((row) => ({
          ...row,
          name: row.folder.name,
          parentId: row.folder.parentId,
          deleted: row.folder.deleted,
        }))[0];
  if (!found) return null;
  // Another project holding the id is not this project's row.
  if (!heldInProject(found, input.projectId, input.userId)) return null;
  if (found.deleted) return { kind: "unreachable" };
  if (found.source.deletedAt || found.sourceProject?.deletedAt || found.work?.deletedAt)
    return { kind: "unreachable" };
  const foldersById = new Map(
    (await loadIdentityFolderClosure(tx, LIVE_TREE, found.parentId ? [found.parentId] : [])).map(
      (folder) => [folder.id, folder],
    ),
  );
  const classification = classifySourceIdentity({
    row: {
      source: found.source,
      sourceProject: found.sourceProject,
      work: found.work,
      ownerThreadRef: found.ownerThreadRef,
      node: { parentId: found.parentId, deleted: false },
    },
    requestProjectId: input.projectId,
    actorUserId: input.userId,
    projectGeneration: "0",
    checkedGeneration: "0",
    foldersById,
  });
  if (classification.kind === "not-visible") return null;
  if (classification.kind !== "valid") return { kind: "unreachable" };
  const { scheme, parentPath } = classification.identity;
  const path = [...parentPath, found.name].join("/");
  return {
    kind: "held",
    address: {
      id: input.node.id,
      scheme,
      path,
      name: found.name,
      workId: found.work?.id ?? null,
      uri: canonicalContextUri(
        scheme,
        path,
        sourceAuthority(
          scheme,
          found.work?.id ?? null,
          found.work && !found.work.isNoWork ? found.work.handle : null,
          found.ownerThreadRef,
          found.source.scope === "chat",
        ),
      ),
    },
  };
}
