import { randomUUID } from "node:crypto";
import type {
  ContextSourceId,
  DocumentId,
  ProjectId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projects, works } from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type {
  BranchPeerShadowAccess,
  DocumentCreationAggregate,
  MarkdownDocumentStore,
} from "../collab/index.js";
import { ensureWorkContextSource } from "../context/context-source-provisioning.js";
import { DrizzleContextDocumentStore } from "../context/index.js";
import { MANUSCRIPT_URI } from "../context/manuscript-uri.js";
import { LIVE_TREE, visibleDocuments } from "../context/tree/tree-view.js";
import {
  ensureProjectManifestSource,
  nextProjectSlug,
} from "./adapters/project-repository/shared.js";
import { NO_WORK_NAME } from "./adapters/work-repository/shared.js";
import type { ContextCatalogLifecyclePort } from "./ports/context-catalog-lifecycle.js";

export const DEFAULT_BOOTSTRAP_URI = MANUSCRIPT_URI;

export { createDrizzleProjectWorkAuthorityResolver } from "./adapters/drizzle-work-authority.js";
export { createDrizzleWorkPurger } from "./adapters/drizzle-work-purge.js";
export {
  type ProjectWorkAuthorityResolver,
  resolvedWorkAuthority,
} from "./domain/work-authority.js";
export {
  type WorkLifecycleState,
  WorkLifecycleUnavailableError,
} from "./domain/work-lifecycle.js";

class BootstrapDocumentSeedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : `Failed to seed chapter document: ${String(cause)}`,
      { cause },
    );
  }
}

export type BootstrapProjectInput = {
  name?: string | null;
  writingType?: string | null;
  writingGoal?: string | null;
  notes?: string | null;
};

export type ProjectBootstrapResult = {
  projectId: ProjectId;
  documentId: DocumentId;
  manuscriptSourceId: ContextSourceId;
  uri: typeof DEFAULT_BOOTSTRAP_URI;
};

export type ProjectBootstrapRepository = {
  /**
   * Reads the durable completion flag and repairs an incomplete bootstrap.
   * Seed failures leave readiness false for a later repair without failing the
   * authenticated request that discovered them.
   */
  ensureDefaultBootstrapReady(userId: UserId): Promise<boolean>;
  ensureDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult>;
};

export function createDrizzleProjectBootstrapRepository(deps: {
  db: Database;
  documents: Pick<MarkdownDocumentStore, "seedFromMarkdown" | "bindStatic"> &
    Pick<DocumentCreationAggregate, "createDocumentAtomically"> &
    Pick<BranchPeerShadowAccess, "recordManifestDocumentCreated">;
  catalogLifecycle: ContextCatalogLifecyclePort;
}): ProjectBootstrapRepository {
  const { db } = deps;
  type BootstrapDb = Pick<Database, "execute" | "insert" | "select" | "update">;

  async function lockBootstrap(tx: BootstrapDb, userId: UserId): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`);
  }

  function projectName(input?: BootstrapProjectInput): string {
    const name = input?.name?.trim();
    return name || "My Serial";
  }

  function projectSystemPrompt(input?: BootstrapProjectInput): string {
    const lines = ["You are a helpful writing assistant for long-form fiction."];
    if (input?.writingType?.trim()) lines.push(`Project type: ${input.writingType.trim()}.`);
    if (input?.writingGoal?.trim()) lines.push(`Writer goal: ${input.writingGoal.trim()}.`);
    if (input?.notes?.trim()) lines.push(`Setup notes: ${input.notes.trim()}.`);
    return lines.join("\n");
  }

  async function ensureProject(
    tx: BootstrapDb,
    userId: UserId,
    input?: BootstrapProjectInput,
  ): Promise<ProjectId> {
    const [existing] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.userId, userId), eq(projects.isPersonal, true), isNull(projects.deletedAt)),
      )
      .limit(1);
    if (existing) return existing.id;

    const reserved = await tx
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.userId, userId));
    const [project] = await tx
      .insert(projects)
      .values({
        userId,
        name: projectName(input),
        slug: nextProjectSlug(
          projectName(input),
          reserved.map((row) => row.slug),
        ),
        isPersonal: true,
        systemPrompt: projectSystemPrompt(input),
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("Failed to create default project");
    return project.id;
  }

  async function ensureLockedNoWork(
    tx: BootstrapDb,
    projectId: ProjectId,
    userId: UserId,
  ): Promise<WorkId> {
    const [existing] = await tx
      .select({ id: works.id })
      .from(works)
      .where(and(eq(works.projectId, projectId), eq(works.isNoWork, true), isNull(works.deletedAt)))
      .limit(1);
    if (existing) return existing.id;
    await tx
      .update(works)
      .set({ name: `${NO_WORK_NAME} (named)`, updatedAt: new Date() })
      .where(
        and(
          eq(works.projectId, projectId),
          eq(works.isNoWork, false),
          isNull(works.deletedAt),
          sql`lower(btrim(${works.name})) = ${NO_WORK_NAME.toLowerCase()}`,
        ),
      );
    const [row] = await tx
      .insert(works)
      .values({
        projectId,
        createdByUserId: userId,
        name: NO_WORK_NAME,
        slug: null,
        isNoWork: true,
        aiWriteMode: "direct",
      })
      .returning({ id: works.id });
    if (!row) throw new Error("Failed to create No Work");
    return row.id;
  }

  async function ensureDocument(
    tx: BootstrapDb,
    projectId: ProjectId,
    contextSourceId: ContextSourceId,
  ): Promise<DocumentId> {
    async function seedDocument(documentId: DocumentId): Promise<void> {
      try {
        // Seeded inside the bootstrap transaction: fixed text with no links, so nothing to register.
        const seeded = await deps.documents.seedFromMarkdown(
          documentId,
          deps.documents.bindStatic("# Chapter 1\n\n"),
          { type: "system" },
        );
        if (!seeded.ok) {
          throw new Error(`Failed to seed chapter document: ${seeded.error.code}`);
        }
      } catch (cause) {
        throw new BootstrapDocumentSeedError(cause);
      }
    }

    const [existing] = await tx
      .select({ id: liveDocuments.id })
      .from(liveDocuments)
      .where(
        and(
          eq(liveDocuments.contextSourceId, contextSourceId),
          eq(liveDocuments.name, "chapter-1"),
          eq(liveDocuments.extension, "md"),
        ),
      )
      .limit(1);
    // Identity, content and membership commit together, so an existing row is whole.
    if (existing) return existing.id;

    const documentId = randomUUID() as DocumentId;
    const created = await deps.documents.createDocumentAtomically({
      persistIdentity: async () => {
        const claimed = await new DrizzleContextDocumentStore({
          db,
          contextSourceId,
          // The live manifest's writer until lane M retires it.
          membershipObserver: {
            documentCreated: (id) =>
              deps.documents.recordManifestDocumentCreated(id as DocumentId, { projectId }),
            documentDeleted: async () => {},
          },
        }).createDocumentRecordIfAbsent({
          id: documentId,
          folderId: null,
          name: "chapter-1",
          extension: "md",
          filetype: "markdown",
          markdown: "",
        });
        return (claimed?.document.id ?? null) as DocumentId | null;
      },
      initializeContent: (claimedId) => seedDocument(claimedId),
    });
    if (!created.created) {
      throw new Error("Failed to claim default chapter document path");
    }
    return documentId;
  }

  async function isDefaultBootstrapReady(userId: UserId): Promise<boolean> {
    const [project] = await db
      .select({ ready: projects.defaultBootstrapReady })
      .from(projects)
      .where(
        and(eq(projects.userId, userId), eq(projects.isPersonal, true), isNull(projects.deletedAt)),
      )
      .limit(1);
    return project?.ready === true;
  }

  async function attemptDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult> {
    const bootstrap = await runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as BootstrapDb;
      await lockBootstrap(tx, userId);
      const projectId = await ensureProject(tx, userId);
      const noWorkId = await ensureLockedNoWork(tx, projectId, userId);
      const manuscriptSourceId = await ensureProjectManifestSource(db, projectId);
      await ensureWorkContextSource(db, noWorkId, "uploads");
      const documentId = await ensureDocument(tx, projectId, manuscriptSourceId);

      const result = {
        projectId,
        documentId,
        manuscriptSourceId,
        uri: DEFAULT_BOOTSTRAP_URI,
      } satisfies ProjectBootstrapResult;

      const [updated] = await tx
        .update(projects)
        .set({ defaultBootstrapReady: true })
        .where(eq(projects.id, projectId))
        .returning({ id: projects.id });
      if (!updated) throw new Error("Failed to mark default bootstrap ready");
      await deps.catalogLifecycle.refreshProject(projectId);
      return result;
    });
    return bootstrap;
  }

  return {
    async ensureDefaultBootstrapReady(userId) {
      if (await isDefaultBootstrapReady(userId)) return true;
      try {
        await attemptDefaultBootstrap(userId);
        return true;
      } catch (cause) {
        if (!(cause instanceof BootstrapDocumentSeedError)) throw cause;
        return false;
      }
    },
    async ensureDefaultBootstrap(userId) {
      return attemptDefaultBootstrap(userId);
    },
  };
}

export type { WorkCatalogEntry } from "@meridian/contracts/works";
// ── Project CRUD ────────────────────────────────────────────────────────────
export { createDrizzleProjectRepository } from "./adapters/project-repository/drizzle.js";
export { createInMemoryProjectRepository } from "./adapters/project-repository/in-memory.js";
// ── User provisioning ───────────────────────────────────────────────────────
export { createDrizzleUserRepository } from "./adapters/user-repository/drizzle.js";
export { createInMemoryUserRepository } from "./adapters/user-repository/in-memory.js";
export {
  createWorkProjectionMutation,
  type WorkProjectionMutation,
} from "./adapters/work-projection-mutation.js";
// ── Work CRUD ───────────────────────────────────────────────────────────────
export { createDrizzleWorkRepository as createDrizzleProjectWorkRepository } from "./adapters/work-repository/drizzle.js";
export { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
export { createWork } from "./create-work.js";
export { deleteWorkTransition, restoreWork } from "./delete-work.js";
export { listWorkCatalog } from "./list-work-catalog.js";
export type {
  CreateProjectInput,
  ListProjectsOptions,
  ProjectRepository,
  UpdateProjectInput,
} from "./ports/project-repository.js";
export {
  AccountLinkConflictError,
  type EnsureUserInput,
  type UserRepository,
} from "./ports/user-repository.js";
export type { WorkDraftPendingCounts } from "./ports/work-draft-pending-counts.js";
export {
  type CreateWorkInput,
  type ListWorksOptions,
  type UpdateWorkInput,
  WorkDeleteRetryError,
  type WorkDeletion,
  WorkLockedError,
  WorkNameConflictError,
  type WorkRepository,
  type WorkRestoration,
  WorkRestoreConflictError,
  WorkRestoreExpiredError,
} from "./ports/work-repository.js";
export { type RequireProjectOwnerOptions, requireProjectOwner } from "./project-access.js";
export { runWorkLifecycleCommand } from "./run-work-lifecycle-command.js";
export {
  normalizeWorkUpdateInput,
  setWorkArchived,
  type UpdateWorkCommandInput,
  updateWorkTransition,
  WorkNameRequiredError,
  WorkStatusInvalidError,
  type WorkTransition,
} from "./update-work.js";
export { requireWorkOwner } from "./work-access.js";
export type { WorkChangeOrigin, WorkContextNotices } from "./work-context-notices.js";

const liveDocuments = visibleDocuments(LIVE_TREE);
