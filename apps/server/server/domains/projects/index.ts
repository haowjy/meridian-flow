import { randomUUID } from "node:crypto";
import type {
  AgentDefinitionId,
  ContextSourceId,
  DocumentId,
  ProjectId,
  UserId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentDefinitions, contextSources, documents, projects } from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type {
  BranchPeerShadowAccess,
  DocumentCreationAggregate,
  MarkdownDocumentStore,
} from "../collab/index.js";
import { MANUSCRIPT_URI } from "../context/manuscript-uri.js";
import type { ContextCatalogLifecyclePort } from "./ports/context-catalog-lifecycle.js";

export const DEFAULT_BOOTSTRAP_URI = MANUSCRIPT_URI;

export { createDrizzleProjectWorkAuthorityResolver } from "./adapters/drizzle-work-authority.js";
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
  agentDefinitionId: AgentDefinitionId;
  uri: typeof DEFAULT_BOOTSTRAP_URI;
};

export type ProjectBootstrapRepository = {
  /** Cheap existence check — no advisory lock or bootstrap side effects. */
  findPersonalProjectId(userId: UserId): Promise<ProjectId | null>;
  /**
   * Reads the durable completion flag and repairs an incomplete bootstrap.
   * Seed failures leave readiness false for a later repair without failing the
   * authenticated request that discovered them.
   */
  ensureDefaultBootstrapReady(userId: UserId): Promise<boolean>;
  ensureDefaultBootstrap(userId: UserId): Promise<ProjectBootstrapResult>;
};

export function createInMemoryProjectBootstrapRepository(): ProjectBootstrapRepository {
  return {
    async findPersonalProjectId() {
      return null;
    },
    async ensureDefaultBootstrapReady() {
      return false;
    },
    async ensureDefaultBootstrap() {
      throw new Error("in-memory project repository is not implemented");
    },
  };
}

export function createDrizzleProjectBootstrapRepository(deps: {
  db: Database;
  documents: Pick<MarkdownDocumentStore, "seedFromMarkdown"> &
    Pick<DocumentCreationAggregate, "createDocumentAtomically" | "repairDocumentAtomically"> &
    Pick<BranchPeerShadowAccess, "recordManifestDocumentCreated">;
  catalogLifecycle?: ContextCatalogLifecyclePort;
}): ProjectBootstrapRepository {
  const { db } = deps;
  const repairedReadyUsers = new Set<UserId>();
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

    const [project] = await tx
      .insert(projects)
      .values({
        userId,
        name: projectName(input),
        slug: `default-${randomUUID()}`,
        isPersonal: true,
        systemPrompt: projectSystemPrompt(input),
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("Failed to create default project");
    return project.id;
  }

  async function ensureAgent(
    tx: BootstrapDb,
    projectId: ProjectId,
    slug = "writer",
    name = "Writer",
    description = "Default fiction-writing assistant.",
  ): Promise<AgentDefinitionId> {
    const [existing] = await tx
      .select({ id: agentDefinitions.id })
      .from(agentDefinitions)
      .where(and(eq(agentDefinitions.projectId, projectId), eq(agentDefinitions.slug, slug)))
      .limit(1);
    if (existing) return existing.id;

    const [agent] = await tx
      .insert(agentDefinitions)
      .values({
        projectId,
        name,
        slug,
        description,
        mode: "primary",
        sourceType: "builtin",
      })
      .returning({ id: agentDefinitions.id });
    if (!agent) throw new Error("Failed to create default agent");
    return agent.id;
  }

  async function ensureContextSource(
    tx: BootstrapDb,
    projectId: ProjectId,
    input: { slug: "manuscript" | "scratch" | "uploads"; name: string; isPrimary?: boolean },
  ): Promise<ContextSourceId> {
    const [existing] = await tx
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(
        and(
          eq(contextSources.projectId, projectId),
          eq(contextSources.slug, input.slug),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const [source] = await tx
      .insert(contextSources)
      .values({
        projectId,
        name: input.name,
        slug: input.slug,
        scope: "project",
        adapterType: "local",
        isPrimary: input.isPrimary ?? false,
      })
      .returning({ id: contextSources.id });
    if (!source) throw new Error(`Failed to create ${input.slug} context source`);
    return source.id;
  }

  async function ensureDocument(
    tx: BootstrapDb,
    projectId: ProjectId,
    contextSourceId: ContextSourceId,
  ): Promise<DocumentId> {
    async function seedDocument(documentId: DocumentId): Promise<void> {
      try {
        const seeded = await deps.documents.seedFromMarkdown(documentId, "# Chapter 1\n\n", {
          type: "system",
        });
        if (!seeded.ok) {
          throw new Error(`Failed to seed chapter document: ${seeded.error.code}`);
        }
      } catch (cause) {
        throw new BootstrapDocumentSeedError(cause);
      }
    }

    const [existing] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, contextSourceId),
          eq(documents.name, "chapter-1"),
          eq(documents.extension, "md"),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    if (existing) {
      await deps.documents.repairDocumentAtomically({
        documentId: existing.id,
        initializeContent: () => seedDocument(existing.id),
        persistMembership: () =>
          deps.documents.recordManifestDocumentCreated(existing.id, { projectId }),
      });
      return existing.id;
    }

    const documentId = randomUUID() as DocumentId;
    const created = await deps.documents.createDocumentAtomically({
      documentId,
      persistIdentity: async () => {
        const [document] = await tx
          .insert(documents)
          .values({
            id: documentId,
            contextSourceId,
            name: "chapter-1",
            extension: "md",
            fileType: "markdown",
            mimeType: "text/markdown",
          })
          .onConflictDoNothing()
          .returning({ id: documents.id });
        return Boolean(document);
      },
      persistMembership: () =>
        deps.documents.recordManifestDocumentCreated(documentId, { projectId }),
      initializeContent: async () => {
        await seedDocument(documentId);
      },
    });
    if (!created.created) {
      throw new Error("Failed to claim default chapter document path");
    }
    return documentId;
  }

  async function findPersonalProjectId(userId: UserId): Promise<ProjectId | null> {
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.userId, userId), eq(projects.isPersonal, true), isNull(projects.deletedAt)),
      )
      .limit(1);
    return existing?.id ?? null;
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
      const agentDefinitionId = await ensureAgent(tx, projectId);
      const manuscriptSourceId = await ensureContextSource(tx, projectId, {
        slug: "manuscript",
        name: "Manuscript",
        isPrimary: true,
      });
      await ensureContextSource(tx, projectId, { slug: "scratch", name: "Scratch" });
      await ensureContextSource(tx, projectId, { slug: "uploads", name: "Uploads" });
      const documentId = await ensureDocument(tx, projectId, manuscriptSourceId);

      const result = {
        projectId,
        documentId,
        manuscriptSourceId,
        agentDefinitionId,
        uri: DEFAULT_BOOTSTRAP_URI,
      } satisfies ProjectBootstrapResult;

      const [updated] = await tx
        .update(projects)
        .set({ defaultBootstrapReady: true })
        .where(eq(projects.id, projectId))
        .returning({ id: projects.id });
      if (!updated) throw new Error("Failed to mark default bootstrap ready");
      await deps.catalogLifecycle?.refreshProject(projectId);
      return result;
    });
    repairedReadyUsers.add(userId);
    return bootstrap;
  }

  return {
    findPersonalProjectId,
    async ensureDefaultBootstrapReady(userId) {
      if ((await isDefaultBootstrapReady(userId)) && repairedReadyUsers.has(userId)) return true;
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
export { deleteWork, deleteWorkTransition, restoreWork } from "./delete-work.js";
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
  WorkDeleteBlockedError,
  WorkNameConflictError,
  type WorkRepository,
  WorkRestoreConflictError,
} from "./ports/work-repository.js";
export { type RequireProjectOwnerOptions, requireProjectOwner } from "./project-access.js";
export {
  normalizeWorkUpdateInput,
  type UpdateWorkCommandInput,
  updateWork,
  updateWorkTransition,
  WorkNameRequiredError,
  type WorkTransition,
} from "./update-work.js";
export { requireWorkOwner } from "./work-access.js";
export type {
  DeliveredWorkContextUpdate,
  WorkContextDelivery,
  WorkContextPostCommitResult,
} from "./work-context-delivery.js";
