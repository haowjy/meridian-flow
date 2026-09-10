/** Drizzle project-final identity lookup and global availability watermarks. */
import { randomUUID } from "node:crypto";
import { type ContextUriScheme, isContextUriScheme } from "@meridian/contracts/context-uri";
import type {
  CatalogScope,
  ProjectContextAuthority,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { PROJECT_CONTEXT_AVAILABILITY_MAX_IDS } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityGeneration,
  contextAvailabilityHeads,
  contextSources,
  documents,
  folders,
  projects,
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
import { mapAuthoritativeFile } from "./catalog-file-mapper.js";

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
  document: typeof documents.$inferSelect;
  source: typeof contextSources.$inferSelect | null;
  sourceProject: typeof projects.$inferSelect | null;
  work: typeof works.$inferSelect | null;
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

function classifyAuthoritativeIdentity(input: {
  row: AvailabilityRow;
  requestProjectId: string;
  actorUserId: string;
  projectGeneration: string;
  checkedGeneration: string;
  foldersById: ReadonlyMap<string, typeof folders.$inferSelect>;
}): IdentityClassification {
  const { document, source, sourceProject, work } = input.row;
  const rawProjectIsRequested = source?.projectId === input.requestProjectId;
  const rawWorkIsRequested = work?.projectId === input.requestProjectId;
  const isActorUserSource =
    source?.slug === "user" &&
    sourceProject?.isPersonal === true &&
    sourceProject.userId === input.actorUserId;
  if (!rawProjectIsRequested && !rawWorkIsRequested && !isActorUserSource) {
    return { kind: "not-visible" };
  }
  if (!source || document.kind !== "content" || !isContextUriScheme(source.slug)) {
    return { kind: "inconsistent" };
  }
  const scheme = source.slug;
  const isWorkScheme = WORK_SCHEMES.has(scheme);
  const hasWorkOwnership = source.scope === "work" && source.workId !== null;
  const hasProjectOwnership = source.scope === "project" && source.projectId !== null;
  if (
    hasWorkOwnership === hasProjectOwnership ||
    (hasWorkOwnership && !isWorkScheme) ||
    (!hasWorkOwnership && !hasProjectOwnership) ||
    (source.workId !== null) !== hasWorkOwnership ||
    (source.projectId !== null) !== hasProjectOwnership ||
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
  if (hasWorkOwnership) {
    const workSlug = decodeWorkSlug(work?.slug);
    if (!work || work.projectId !== input.requestProjectId || !workSlug) {
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
    scope = { kind: "none", projectId: input.requestProjectId } as never;
    authority = { kind: "none", projectId: input.requestProjectId } as never;
  } else {
    scope = { kind: "project", projectId: input.requestProjectId } as never;
    authority = { kind: "project", projectId: input.requestProjectId } as never;
  }

  const parentPath: string[] = [];
  const visited = new Set<string>();
  let folderId = document.folderId;
  while (folderId) {
    if (visited.has(folderId)) return { kind: "inconsistent" };
    visited.add(folderId);
    const folder = input.foldersById.get(folderId);
    if (
      !folder ||
      folder.contextSourceId !== source.id ||
      (document.deletedAt === null && source.deletedAt === null && folder.deletedAt !== null)
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
        if (missing.length === 0 && state.generation !== undefined) {
          return String(state.generation);
        }
        if (!state.publisherFenceHeld) {
          // One transaction-scoped publisher fence makes sequence allocation order match
          // commit visibility even when later advance calls introduce previously unknown keys.
          await tx.execute(sql`select pg_advisory_xact_lock(1296387666, 1096174676)`);
          state.publisherFenceHeld = true;
        }
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
            .set({ generation: state.generation, updatedAt: new Date() })
            .where(inArray(contextAvailabilityHeads.authorityKey, missing));
          for (const key of missing) state.keys.add(key);
        }
        return String(state.generation);
      });
    },

    async lookup(input, actor) {
      const ids = normalizeAvailabilityDocumentIds(input.documentIds);
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
          const projectGeneration = head.get(projectKey(input.projectId)) ?? 0n;
          const checkedGeneration = String(
            [projectGeneration, head.get(userKey(actor.userId)) ?? 0n].reduce((a, b) =>
              a > b ? a : b,
            ),
          );
          if (ids.length === 0) {
            return { projectId: input.projectId, resolutionId: randomUUID(), resolutions: [] };
          }
          const rows = await tx
            .select({
              document: documents,
              source: contextSources,
              sourceProject: projects,
              work: works,
            })
            .from(documents)
            .leftJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
            .leftJoin(projects, eq(contextSources.projectId, projects.id))
            .leftJoin(works, eq(contextSources.workId, works.id))
            .where(inArray(documents.id, ids as never));
          const byId = new Map(rows.map((row) => [row.document.id, row]));
          const sourceIds = [
            ...new Set(rows.flatMap((row) => (row.source ? [row.source.id] : []))),
          ];
          const folderRows = sourceIds.length
            ? await tx
                .select()
                .from(folders)
                .where(inArray(folders.contextSourceId, sourceIds as never))
            : [];
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
            if (work?.status === "archived") {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "work_archived",
              } as never;
            }
            if (document.deletedAt || source?.deletedAt) {
              return { kind: "deleted", documentId, generation, lastAuthority: authority } as never;
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
                  scheme,
                  workId: authority.kind === "work" ? authority.workId : null,
                  workSlug: authority.kind === "work" ? authority.workSlug : null,
                  parentPath,
                }),
              } as never;
            } catch {
              return indeterminate();
            }
          });
          return { projectId: input.projectId, resolutionId: randomUUID(), resolutions } as never;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
