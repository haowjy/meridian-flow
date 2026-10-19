/** Drizzle project-final identity lookup and global availability watermarks. */

import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
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
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityGeneration,
  contextAvailabilityHeads,
  contextNamespaceObservationVersion,
  contextSources,
  type folders,
  projects,
  threads,
  works,
} from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type {
  ProjectContextAvailabilityMutationPort,
  ProjectContextAvailabilityPort,
} from "../ports/project-context-availability.js";
import { createDrizzleDocumentRemovals } from "../tree/document-removals.js";
import {
  identityDocumentFields,
  identityDocuments,
  identityFolderFields,
  identityFolders,
  LIVE_TREE,
} from "../tree/tree-view.js";
import {
  type CatalogFileRow,
  catalogSourceAuthority,
  mapAuthoritativeFile,
} from "./catalog-file-mapper.js";

const ADVANCE_STATE = {};
type AdvanceState = { generation?: bigint; keys: Set<string>; publisherFenceHeld: boolean };
const advanceParticipant: DrizzleTransactionParticipant<AdvanceState> = {
  key: ADVANCE_STATE,
  create: () => ({ keys: new Set(), publisherFenceHeld: false }),
  fork: (parent) => ({
    generation: parent.generation,
    keys: new Set(parent.keys),
    publisherFenceHeld: parent.publisherFenceHeld,
  }),
  merge(parent, child) {
    if (
      parent.generation !== undefined &&
      child.generation !== undefined &&
      parent.generation !== child.generation
    ) {
      throw new Error("Availability generation changed inside one ambient transaction");
    }
    return {
      generation: parent.generation ?? child.generation,
      keys: new Set([...parent.keys, ...child.keys]),
      publisherFenceHeld: parent.publisherFenceHeld || child.publisherFenceHeld,
    };
  },
};
type AvailabilityRow = {
  document: CatalogFileRow & { deletedAt?: Date | null };
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

type IdentityFolder = Pick<
  typeof folders.$inferSelect,
  "id" | "name" | "parentId" | "contextSourceId"
> & { deletedAt?: Date | null };

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
        deletedAt: input.row.document.deletedAt ?? null,
      },
    },
  });
}

function classifySourceIdentity(input: {
  row: Omit<AvailabilityRow, "document"> & {
    node: { parentId: string | null; deletedAt: Date | null };
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
    const workSlug = work.isNoWork ? null : decodeWorkSlug(work.slug);
    if (!work.isNoWork && !workSlug) {
      return { kind: "inconsistent" };
    }
    scope = { kind: "work", projectId: input.requestProjectId, workId: work.id } as never;
    authority = {
      kind: "work",
      projectId: input.requestProjectId,
      workId: work.id,
      workSlug,
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
    if (
      !folder ||
      folder.contextSourceId !== source.id ||
      (!node.deletedAt && source.deletedAt === null && !!folder.deletedAt)
    ) {
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

/** One transaction-scoped publisher fence makes sequence allocation order match commit
 * visibility, even when later calls introduce previously unknown keys. */
async function holdPublisherFence(tx: Database, state: AdvanceState) {
  if (state.publisherFenceHeld) return;
  await tx.execute(sql`select pg_advisory_xact_lock(1296387666, 1096174676)`);
  state.publisherFenceHeld = true;
}

/** The caller holds the publisher fence. Each namespace change needs its own stamp even
 * when availability groups several changes in one transaction. */
async function publishNamespaceVersion(
  tx: Database,
  authorityKeys: readonly string[],
): Promise<string | null> {
  const keys = [...new Set(authorityKeys)].sort();
  if (!keys.length) return null;
  const [row] = await tx.execute<{ version: string }>(
    sql`select nextval(${sql.raw(`'${contextNamespaceObservationVersion.seqName}'`)})::text as version`,
  );
  if (!row) throw new Error("Failed to allocate namespace observation version");
  const version = BigInt(row.version);
  await tx
    .insert(contextAvailabilityHeads)
    .values(
      keys.map((authorityKey) => ({
        authorityKey,
        generation: 0n,
        namespaceGeneration: version,
      })),
    )
    .onConflictDoUpdate({
      target: contextAvailabilityHeads.authorityKey,
      set: { namespaceGeneration: version },
    });
  return String(version);
}

export function createDrizzleProjectContextAvailability(
  db: Database,
  eventSink?: EventSink,
): ProjectContextAvailabilityPort & ProjectContextAvailabilityMutationPort {
  return {
    async advance(input) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        const requested = new Set([
          ...input.projectIds.map(projectKey),
          ...input.userIds.map(userKey),
        ]);
        const state = enlistDrizzleTransactionParticipant(advanceParticipant);
        const missing = [...requested].filter((key) => !state.keys.has(key)).sort();
        await holdPublisherFence(tx, state);
        if (missing.length > 0) {
          await tx
            .insert(contextAvailabilityHeads)
            .values(missing.map((authorityKey) => ({ authorityKey, generation: 0n })))
            .onConflictDoNothing({ target: contextAvailabilityHeads.authorityKey });
          // Lock one canonical key at a time rather than relying on a query plan's row-lock order.
          for (const authorityKey of missing) {
            await tx.execute(
              sql`select authority_key from context_availability_heads where authority_key = ${authorityKey} for update`,
            );
          }
        }
        if (state.generation === undefined) {
          const result = await tx.execute<{ generation: string }>(
            sql`select nextval(${sql.raw(`'${contextAvailabilityGeneration.seqName}'`)})::text as generation`,
          );
          const value = result[0]?.generation;
          if (!value) throw new Error("Failed to allocate availability generation");
          state.generation = BigInt(value);
        }
        if (missing.length > 0) {
          await tx
            .update(contextAvailabilityHeads)
            .set({
              generation: state.generation,
              updatedAt: new Date(),
            })
            .where(inArray(contextAvailabilityHeads.authorityKey, missing));
          for (const key of missing) state.keys.add(key);
        }
        return String(state.generation);
      });
    },

    async publishNamespace(input) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        await holdPublisherFence(tx, enlistDrizzleTransactionParticipant(advanceParticipant));
        const version = await publishNamespaceVersion(tx, [
          ...input.projectIds.map(projectKey),
          ...input.userIds.map(userKey),
        ]);
        if (version === null) throw new Error("publishNamespace needs at least one authority");
        return version;
      });
    },

    async lookup(input, actor) {
      const documents = identityDocuments(input.view ?? LIVE_TREE);
      const folders = identityFolders(input.view ?? LIVE_TREE);
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
          const rows = await tx
            .select({
              document: identityDocumentFields(documents),
              source: contextSources,
              sourceProject: projects,
              work: works,
              ownerThreadRef: threads.ref,
            })
            .from(documents)
            .leftJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
            .leftJoin(projects, eq(contextSources.projectId, projects.id))
            .leftJoin(works, eq(contextSources.workId, works.id))
            .leftJoin(
              threads,
              eq(
                threads.id,
                sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`,
              ),
            )
            .where(inArray(documents.id, ids as never));
          const requestedFolders = folderIds.length
            ? await tx
                .select({
                  folder: identityFolderFields(folders),
                  source: contextSources,
                  sourceProject: projects,
                  work: works,
                  ownerThreadRef: threads.ref,
                })
                .from(folders)
                .leftJoin(contextSources, eq(folders.contextSourceId, contextSources.id))
                .leftJoin(projects, eq(contextSources.projectId, projects.id))
                .leftJoin(works, eq(contextSources.workId, works.id))
                .leftJoin(
                  threads,
                  eq(
                    threads.id,
                    sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`,
                  ),
                )
                .where(inArray(folders.id, folderIds as never))
            : [];
          const byId = new Map(rows.map((row) => [row.document.id, row]));
          const sourceIds = [
            ...new Set(
              [...rows, ...requestedFolders].flatMap((row) => (row.source ? [row.source.id] : [])),
            ),
          ];
          const folderRows = sourceIds.length
            ? await tx
                .select()
                .from(folders)
                .where(inArray(folders.contextSourceId, sourceIds as never))
            : [];
          const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));

          const removals = await createDrizzleDocumentRemovals(db).lookup(
            rows
              .filter((row) => row.document.deletedAt)
              .map((row) => row.document.id as DocumentId),
          );
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
            // A discarded creation only answers its removal: one that cannot be placed
            // (its draft folder went with it) stays not visible, never inconsistent.
            if (
              classification.kind === "not-visible" ||
              (classification.kind === "inconsistent" &&
                document.deletedAt &&
                document.deletionReason === "discarded")
            ) {
              return { kind: "not-visible", documentId, checkedGeneration } as never;
            }
            if (classification.kind === "inconsistent") return indeterminate();
            const { scope, authority, scheme, generation, parentPath } = classification.identity;
            // The same liveness facts the SQL predicates filter on, but this site
            // has to name the one that failed, so it classifies rather than filters.
            // Independent document deletion remains deletion even when its authority hides.
            // Work-cascade tombstones belong to the reversible authority lifecycle.
            if (document.deletedAt && !document.deletedByWorkId) {
              return {
                kind: "deleted",
                documentId,
                generation,
                observationVersion: namespaceVersion(scope),
                lastAuthority: authority,
                removal: removals.get(documentId as DocumentId),
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
            if (document.deletedAt || source?.deletedAt) {
              return {
                kind: "deleted",
                documentId,
                generation,
                observationVersion: namespaceVersion(scope),
                lastAuthority: authority,
                removal: removals.get(documentId as DocumentId),
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
                  workSlug: work && !work.isNoWork ? work.slug : null,
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
                node: { parentId: row.folder.parentId, deletedAt: row.folder.deletedAt },
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
            // Independent tombstones are final; Work/lineage unavailability is not deletion.
            if (row.folder.deletedAt && !row.folder.deletedByWorkId)
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
                  catalogSourceAuthority(
                    scheme,
                    row.work?.id ?? null,
                    row.work && !row.work.isNoWork ? row.work.slug : null,
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
  };
}

/**
 * Resolve an active live folder inside the caller's namespace transaction, without a new
 * snapshot. A hidden folder is missing: no live writer could have picked it.
 */
export async function resolveActiveFolderUri(
  db: Database,
  projectId: string,
  userId: string,
  folderId: string,
): Promise<string | null> {
  const tx = currentDrizzleDb(db);
  const folders = identityFolders(LIVE_TREE);
  const [row] = await tx
    .select({
      folder: identityFolderFields(folders),
      source: contextSources,
      sourceProject: projects,
      work: works,
      ownerThreadRef: threads.ref,
    })
    .from(folders)
    .leftJoin(contextSources, eq(folders.contextSourceId, contextSources.id))
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(
      threads,
      eq(threads.id, sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`),
    )
    .where(eq(folders.id, folderId));
  if (
    !row?.source ||
    row.folder.deletedAt ||
    row.source.deletedAt ||
    row.sourceProject?.deletedAt ||
    row.work?.deletedAt ||
    row.work?.archivedAt
  )
    return null;
  const ancestors = await tx
    .select()
    .from(folders)
    .where(eq(folders.contextSourceId, row.source.id));
  const classification = classifySourceIdentity({
    row: { ...row, node: { parentId: row.folder.parentId, deletedAt: row.folder.deletedAt } },
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
    catalogSourceAuthority(
      classification.identity.scheme,
      row.work?.id ?? null,
      row.work && !row.work.isNoWork ? row.work.slug : null,
      row.ownerThreadRef,
      row.source.scope === "chat",
    ),
  );
}
