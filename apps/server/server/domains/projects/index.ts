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
  works,
} from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";

export const DEFAULT_BOOTSTRAP_URI = "work://manuscript/chapter-1.md";

export type DefaultBootstrap = {
  projectId: ProjectId;
  workId: WorkId;
  threadId: ThreadId;
  documentId: DocumentId;
  contextSourceId: ContextSourceId;
  agentDefinitionId: AgentDefinitionId;
  uri: typeof DEFAULT_BOOTSTRAP_URI;
};

export type ProjectRepository = {
  ensureDefaultBootstrap(userId: UserId): Promise<DefaultBootstrap>;
};

export type WorkRepository = {
  readonly phase: "phase4";
};

export function createInMemoryProjectRepository(): ProjectRepository {
  return {
    async ensureDefaultBootstrap() {
      throw new Error("in-memory project repository is not implemented");
    },
  };
}

export function createInMemoryWorkRepository(): WorkRepository {
  return { phase: "phase4" };
}

export function createDrizzleProjectRepository(db: Database): ProjectRepository {
  type BootstrapDb = Pick<Database, "execute" | "insert" | "select">;

  async function lockBootstrap(tx: BootstrapDb, userId: UserId): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`);
  }

  async function ensureProject(tx: BootstrapDb, userId: UserId): Promise<ProjectId> {
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
        name: "My Serial",
        slug: `default-${randomUUID()}`,
        isPersonal: true,
        systemPrompt: "You are a helpful writing assistant for long-form fiction.",
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("Failed to create default project");
    return project.id;
  }

  async function ensureAgent(tx: BootstrapDb, projectId: ProjectId): Promise<AgentDefinitionId> {
    const [existing] = await tx
      .select({ id: agentDefinitions.id })
      .from(agentDefinitions)
      .where(and(eq(agentDefinitions.projectId, projectId), eq(agentDefinitions.slug, "writer")))
      .limit(1);
    if (existing) return existing.id;

    const [agent] = await tx
      .insert(agentDefinitions)
      .values({
        projectId,
        name: "Writer",
        slug: "writer",
        description: "Default fiction-writing assistant.",
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

  async function ensureContextSource(tx: BootstrapDb, workId: WorkId): Promise<ContextSourceId> {
    const [existing] = await tx
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(
        and(
          eq(contextSources.workId, workId),
          eq(contextSources.slug, "manuscript"),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const [source] = await tx
      .insert(contextSources)
      .values({
        workId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "work",
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
    },
  ): Promise<ThreadId> {
    const [linked] = await tx
      .select({ id: threads.id })
      .from(threadDocuments)
      .innerJoin(threads, eq(threads.id, threadDocuments.threadId))
      .where(
        and(
          eq(threadDocuments.documentId, input.documentId),
          eq(threadDocuments.relationship, "editing"),
          eq(threads.workId, input.workId),
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
        workId: input.workId,
        createdByUserId: input.userId,
        title: "Chapter 1",
        kind: "primary",
        currentAgentId: input.agentDefinitionId,
      })
      .returning({ id: threads.id });
    if (!thread) throw new Error("Failed to create primary thread");

    await tx.insert(threadDocuments).values({
      threadId: thread.id,
      documentId: input.documentId,
      relationship: "editing",
    });

    return thread.id;
  }

  return {
    async ensureDefaultBootstrap(userId) {
      const bootstrap = await db.transaction(async (tx): Promise<DefaultBootstrap> => {
        await lockBootstrap(tx, userId);
        const projectId = await ensureProject(tx, userId);
        const agentDefinitionId = await ensureAgent(tx, projectId);
        const workId = await ensureWork(tx, projectId, userId);
        const contextSourceId = await ensureContextSource(tx, workId);
        const documentId = await ensureDocument(tx, contextSourceId);
        const threadId = await ensureThread(tx, {
          projectId,
          workId,
          userId,
          documentId,
          agentDefinitionId,
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

      return bootstrap;
    },
  };
}

export function createDrizzleWorkRepository(_db: Database): WorkRepository {
  return createInMemoryWorkRepository();
}
