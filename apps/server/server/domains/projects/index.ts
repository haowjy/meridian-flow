import { randomUUID } from "node:crypto";
import type {
  AgentDefinitionId,
  ContextSourceId,
  DocumentId,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentDefinitions,
  contextSources,
  documents,
  projects,
  threadDocuments,
  threads,
  threadWorks,
  works,
} from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";

export const DEFAULT_BOOTSTRAP_URI = "work://manuscript/chapter-1.md";

export type BootstrapProjectInput = {
  name?: string | null;
  writingType?: string | null;
  writingGoal?: string | null;
  notes?: string | null;
};

export type DefaultBootstrap = {
  projectId: ProjectId;
  workId: WorkId;
  threadId: ThreadId;
  documentId: DocumentId;
  contextSourceId: ContextSourceId;
  agentDefinitionId: AgentDefinitionId;
  uri: typeof DEFAULT_BOOTSTRAP_URI;
};

export type ProjectBootstrapRepository = {
  ensureDefaultBootstrap(userId: UserId): Promise<DefaultBootstrap>;
  createOnboardingBootstrap(
    userId: UserId,
    input: BootstrapProjectInput,
  ): Promise<DefaultBootstrap>;
};

export function createInMemoryProjectBootstrapRepository(): ProjectBootstrapRepository {
  return {
    async ensureDefaultBootstrap() {
      throw new Error("in-memory project repository is not implemented");
    },
    async createOnboardingBootstrap() {
      throw new Error("in-memory project repository is not implemented");
    },
  };
}

export function createDrizzleProjectBootstrapRepository(db: Database): ProjectBootstrapRepository {
  type BootstrapDb = Pick<Database, "execute" | "insert" | "select">;

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

  async function ensureWork(
    tx: BootstrapDb,
    projectId: ProjectId,
    userId: UserId,
  ): Promise<WorkId> {
    const [existing] = await tx
      .select({ id: works.id })
      .from(works)
      .where(
        and(
          eq(works.projectId, projectId),
          eq(works.createdByUserId, userId),
          isNull(works.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const [work] = await tx
      .insert(works)
      .values({
        projectId,
        createdByUserId: userId,
        title: "Book 1",
      })
      .returning({ id: works.id });
    if (!work) throw new Error("Failed to create default work");
    return work.id;
  }

  async function ensureContextSource(
    tx: BootstrapDb,
    projectId: ProjectId,
  ): Promise<ContextSourceId> {
    const [existing] = await tx
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(
        and(
          eq(contextSources.projectId, projectId),
          eq(contextSources.slug, "manuscript"),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const [source] = await tx
      .insert(contextSources)
      .values({
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        adapterType: "local",
        isPrimary: true,
      })
      .returning({ id: contextSources.id });
    if (!source) throw new Error("Failed to create manuscript context source");
    return source.id;
  }

  async function ensureDocument(
    tx: BootstrapDb,
    contextSourceId: ContextSourceId,
  ): Promise<DocumentId> {
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
    if (existing) return existing.id;

    const [document] = await tx
      .insert(documents)
      .values({
        contextSourceId,
        name: "chapter-1",
        extension: "md",
        fileType: "markdown",
        mimeType: "text/markdown",
        markdownProjection: "# Chapter 1\n\n",
      })
      .returning({ id: documents.id });
    if (!document) throw new Error("Failed to create chapter document");
    return document.id;
  }

  async function ensureThread(
    tx: BootstrapDb,
    input: {
      projectId: ProjectId;
      workId: WorkId;
      userId: UserId;
      documentId: DocumentId;
      agentDefinitionId: AgentDefinitionId;
      agentSlug?: string;
    },
  ): Promise<ThreadId> {
    const [linked] = await tx
      .select({ id: threads.id })
      .from(threadDocuments)
      .innerJoin(threads, eq(threads.id, threadDocuments.threadId))
      .innerJoin(
        threadWorks,
        and(eq(threadWorks.threadId, threads.id), eq(threadWorks.workId, input.workId)),
      )
      .where(
        and(
          eq(threadDocuments.documentId, input.documentId),
          eq(threadDocuments.relationship, "editing"),
          eq(threads.kind, "primary"),
          isNull(threads.deletedAt),
        ),
      )
      .limit(1);
    if (linked) return linked.id;

    const [thread] = await tx
      .insert(threads)
      .values({
        projectId: input.projectId,
        createdByUserId: input.userId,
        title: "Chapter 1",
        kind: "primary",
        currentAgentId: input.agentSlug ?? "writer",
      })
      .returning({ id: threads.id });
    if (!thread) throw new Error("Failed to create primary thread");

    await tx.insert(threadWorks).values({
      threadId: thread.id,
      workId: input.workId,
      projectId: input.projectId,
      isPrimary: true,
    });

    await tx.insert(threadDocuments).values({
      threadId: thread.id,
      documentId: input.documentId,
      relationship: "editing",
    });

    return thread.id;
  }

  return {
    async ensureDefaultBootstrap(userId) {
      return db.transaction(async (tx): Promise<DefaultBootstrap> => {
        await lockBootstrap(tx, userId);
        const projectId = await ensureProject(tx, userId);
        const agentDefinitionId = await ensureAgent(tx, projectId);
        const workId = await ensureWork(tx, projectId, userId);
        const contextSourceId = await ensureContextSource(tx, projectId);
        const documentId = await ensureDocument(tx, contextSourceId);
        const threadId = await ensureThread(tx, {
          projectId,
          workId,
          userId,
          documentId,
          agentDefinitionId,
          agentSlug: "writer",
        });

        return {
          projectId,
          workId,
          threadId,
          documentId,
          contextSourceId,
          agentDefinitionId,
          uri: DEFAULT_BOOTSTRAP_URI,
        };
      });
    },
    async createOnboardingBootstrap(userId, input) {
      return db.transaction(async (tx): Promise<DefaultBootstrap> => {
        await lockBootstrap(tx, userId);
        const projectId = await ensureProject(tx, userId, input);
        const agentDefinitionId = await ensureAgent(
          tx,
          projectId,
          "setup",
          "Setup",
          "Onboarding agent that gathers project context.",
        );
        const workId = await ensureWork(tx, projectId, userId);
        const contextSourceId = await ensureContextSource(tx, projectId);
        const documentId = await ensureDocument(tx, contextSourceId);
        const threadId = await ensureThread(tx, {
          projectId,
          workId,
          userId,
          documentId,
          agentDefinitionId,
          agentSlug: "setup",
        });

        return {
          projectId,
          workId,
          threadId,
          documentId,
          contextSourceId,
          agentDefinitionId,
          uri: DEFAULT_BOOTSTRAP_URI,
        };
      });
    },
  };
}

// ── Project CRUD ────────────────────────────────────────────────────────────
export { createDrizzleProjectRepository } from "./adapters/project-repository/drizzle.js";
export { createInMemoryProjectRepository } from "./adapters/project-repository/in-memory.js";
// ── User provisioning ───────────────────────────────────────────────────────
export { createDrizzleUserRepository } from "./adapters/user-repository/drizzle.js";
export { createInMemoryUserRepository } from "./adapters/user-repository/in-memory.js";
// ── Work CRUD ───────────────────────────────────────────────────────────────
export { createDrizzleWorkRepository as createDrizzleProjectWorkRepository } from "./adapters/work-repository/drizzle.js";
export { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
export type {
  CreateProjectInput,
  ListProjectsOptions,
  ProjectRepository,
  UpdateProjectInput,
} from "./ports/project-repository.js";
export type { EnsureUserInput, UserRepository } from "./ports/user-repository.js";
export type { CreateWorkInput, ListWorksOptions, WorkRepository } from "./ports/work-repository.js";
export { type RequireProjectOwnerOptions, requireProjectOwner } from "./project-access.js";
