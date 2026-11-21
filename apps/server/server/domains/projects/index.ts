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
import { LIVE, sourceRoot } from "@meridian/project-tree";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type { DocumentCreationAggregate, MarkdownDocumentStore } from "../collab/index.js";
import { treeListOfSource } from "../context/adapters/tree-list-facts.js";
import { provisionProjectSources } from "../context/context-source-provisioning.js";
import { MANUSCRIPT_URI } from "../context/manuscript-uri.js";
import type { TreeListStore } from "../context/ports/tree-list-store.js";
import { nextProjectSlug } from "./adapters/project-repository/shared.js";
import { NO_WORK_NAME } from "./adapters/work-repository/shared.js";

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
   * Makes the account's first project when it has no live one: after its last project is
   * deleted, the next sign-in makes another. A seed failure leaves it without one for a later
   * attempt, without failing the authenticated request that found it.
   */
  ensureDefaultBootstrapReady(userId: UserId): Promise<boolean>;
  /** The project it made, or null when the account already had a live one. */
  ensureDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult | null>;
};

export function createDrizzleProjectBootstrapRepository(deps: {
  db: Database;
  documents: Pick<MarkdownDocumentStore, "seedFromMarkdown" | "bindStatic"> &
    Pick<DocumentCreationAggregate, "createDocumentAtomically">;
  treeLists: TreeListStore;
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

  async function hasLiveProject(tx: BootstrapDb, userId: UserId): Promise<boolean> {
    const [existing] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
      .limit(1);
    return existing !== undefined;
  }

  async function createProject(
    tx: BootstrapDb,
    userId: UserId,
    input?: BootstrapProjectInput,
  ): Promise<ProjectId> {
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
        systemPrompt: projectSystemPrompt(input),
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("Failed to create default project");
    return project.id;
  }

  async function createNoWork(
    tx: BootstrapDb,
    projectId: ProjectId,
    userId: UserId,
  ): Promise<WorkId> {
    const [row] = await tx
      .insert(works)
      .values({
        projectId,
        createdByUserId: userId,
        name: NO_WORK_NAME,
        handle: null,
        isNoWork: true,
        defaultAiWriteMode: "direct",
      })
      .returning({ id: works.id });
    if (!row) throw new Error("Failed to create No Work");
    return row.id;
  }

  async function createChapter(
    tx: BootstrapDb,
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

    const documentId = randomUUID() as DocumentId;
    const created = await deps.documents.createDocumentAtomically({
      persistIdentity: async () => {
        await deps.treeLists.submit({
          lists: [await treeListOfSource(tx as unknown as Database, contextSourceId)],
          make: ([{ writer }]) => {
            writer.create(LIVE, "system", {
              kind: "document",
              filetype: "markdown",
              name: "Chapter 1",
              parent: sourceRoot(contextSourceId),
              node: documentId,
            });
          },
        });
        return documentId;
      },
      initializeContent: (claimedId) => seedDocument(claimedId),
    });
    if (!created.created) {
      throw new Error("Failed to claim default chapter document path");
    }
    return documentId;
  }

  async function attemptDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult | null> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as BootstrapDb;
      await lockBootstrap(tx, userId);
      // A bootstrap that raced this one made it; it is one transaction, so it is whole.
      if (await hasLiveProject(tx, userId)) return null;
      const projectId = await createProject(tx, userId);
      await createNoWork(tx, projectId, userId);
      const manuscriptSourceId = await provisionProjectSources(db, projectId);
      const documentId = await createChapter(tx, manuscriptSourceId);
      return {
        projectId,
        documentId,
        manuscriptSourceId,
        uri: DEFAULT_BOOTSTRAP_URI,
      } satisfies ProjectBootstrapResult;
    });
  }

  return {
    async ensureDefaultBootstrapReady(userId) {
      if (await hasLiveProject(db, userId)) return true;
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

// ── Project CRUD ────────────────────────────────────────────────────────────
export { createDrizzleProjectRepository } from "./adapters/project-repository/drizzle.js";
export { createInMemoryProjectRepository } from "./adapters/project-repository/in-memory.js";
// ── User provisioning ───────────────────────────────────────────────────────
export { createDrizzleUserRepository } from "./adapters/user-repository/drizzle.js";
export { createInMemoryUserRepository } from "./adapters/user-repository/in-memory.js";
export {
  createWorkProjectionMutation,
  type LockedWorkWriteSet,
  type WorkProjectionMutation,
  type WorkWriteOptions,
  type WorkWriteSet,
} from "./adapters/work-projection-mutation.js";
// ── Work CRUD ───────────────────────────────────────────────────────────────
export { createDrizzleWorkRepository as createDrizzleProjectWorkRepository } from "./adapters/work-repository/drizzle.js";
export { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
export { createWork } from "./create-work.js";
export { deleteWorkTransition, restoreWork, softDeleteWork } from "./delete-work.js";
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
export type { WorkDraftDisposal } from "./ports/work-draft-disposal.js";
export type { WorkDraftPendingCounts } from "./ports/work-draft-pending-counts.js";
export {
  type CreateWorkInput,
  type ListWorksOptions,
  type UpdateWorkInput,
  WorkDeleteRetryError,
  type WorkDeletion,
  WorkLockedError,
  type WorkRepository,
  type WorkRestoration,
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
