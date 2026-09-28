import { catalogScopeKey } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  type AiWriteMode,
  decodeWorkSlug,
  type Work,
  type WorkStatus,
  workPurgeAt,
} from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextCatalogScopeHeads,
  contextSources,
  documentBranches,
  documents,
  folders,
  projectResults,
  projects,
  threads,
  threadWorks,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../../shared/thread-work-lock.js";
import { isUuid } from "../../../../shared/uuid.js";
import { lockWorkLifecycle } from "../../../../shared/work-lifecycle-lock.js";
import type {
  CreateWorkInput,
  ListWorksOptions,
  UpdateWorkInput,
  WorkRepository,
  WorkRestoration,
} from "../../ports/work-repository.js";
import {
  WorkDeleteRetryError,
  WorkLockedError,
  WorkNameConflictError,
  WorkRestoreConflictError,
  WorkRestoreExpiredError,
} from "../../ports/work-repository.js";
import type { WorkProjectionMutation } from "../work-projection-mutation.js";
import { NO_WORK_NAME, nextWorkSlug } from "./shared.js";

type WorkRow = typeof works.$inferSelect;
function workUniqueConstraint(cause: unknown): string | null {
  let current: unknown = cause;
  while (current) {
    const error = current as { cause?: unknown; code?: unknown; constraint_name?: unknown };
    if (error.code === "23505" && typeof error.constraint_name === "string") {
      return error.constraint_name;
    }
    current = error.cause;
  }
  return null;
}

function mapWork(row: WorkRow): Work {
  const slug = row.isNoWork ? null : decodeWorkSlug(row.slug);
  if (!row.isNoWork && !slug) throw new Error(`Persisted Work ${row.id} has an invalid slug`);
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    slug,
    isNoWork: row.isNoWork,
    goal: row.goal,
    status: row.status as WorkStatus,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    aiWriteMode: row.aiWriteMode as AiWriteMode,
    entityRevision: String(row.entityRevision),
    lastActivityAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
export interface DrizzleWorkRepositoryDeps {
  db: Database;
  /** Canonical collab-domain predicate for reviewable Work draft content. */
  hasUnreviewedDraft(workId: WorkId): Promise<boolean>;
  projectionMutation: WorkProjectionMutation;
}
export function createDrizzleWorkRepository(deps: DrizzleWorkRepositoryDeps): WorkRepository {
  const { db, hasUnreviewedDraft } = deps;
  const projectionMutation = deps.projectionMutation;

  async function lockProjectWorkCreation(projectId: ProjectId): Promise<void> {
    await currentDrizzleDb(db).execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 42::bigint))`,
    );
  }

  async function findWorkById(id: WorkId): Promise<Work | null> {
    if (!isUuid(id)) return null;
    const [row] = await currentDrizzleDb(db).select().from(works).where(eq(works.id, id)).limit(1);
    return row ? mapWork(row) : null;
  }

  async function findNoWorkRow(projectId: ProjectId): Promise<Work | null> {
    const [row] = await currentDrizzleDb(db)
      .select()
      .from(works)
      .where(and(eq(works.projectId, projectId), eq(works.isNoWork, true), isNull(works.deletedAt)))
      .limit(1);
    return row ? mapWork(row) : null;
  }

  async function requireUnlocked(id: WorkId): Promise<Work> {
    const existing = await findWorkById(id);
    if (!existing || existing.deletedAt) throw new Error(`Work not found: ${id}`);
    if (existing.isNoWork) throw new WorkLockedError();
    return existing;
  }

  async function updateWork(id: WorkId, patch: Partial<typeof works.$inferInsert>): Promise<Work> {
    return runInDrizzleTransaction(db, async () => {
      if (!isUuid(id)) throw new Error(`Work not found: ${id}`);
      const [row] = await currentDrizzleDb(db)
        .update(works)
        .set({ ...patch, entityRevision: sql`${works.entityRevision} + 1`, updatedAt: new Date() })
        .where(and(eq(works.id, id), isNull(works.deletedAt)))
        .returning();
      if (!row) throw new Error(`Work not found: ${id}`);
      await projectionMutation.publishWorks([row.id]);
      return mapWork(row);
    });
  }

  async function findPrimaryThreadTree(workId: WorkId): Promise<{
    threadIds: ThreadId[];
    liveThreadIds: ThreadId[];
  }> {
    const activeDb = currentDrizzleDb(db);
    const roots = await activeDb
      .select({ id: threads.id, deletedAt: threads.deletedAt })
      .from(threadWorks)
      .innerJoin(threads, eq(threadWorks.threadId, threads.id))
      .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, true)));
    const allIds = new Set<ThreadId>();
    const liveIds = new Set<ThreadId>();
    let frontier: ThreadId[] = [];
    for (const row of roots) {
      allIds.add(row.id);
      if (!row.deletedAt) liveIds.add(row.id);
      frontier.push(row.id);
    }

    while (frontier.length > 0) {
      const children = await activeDb
        .select({ id: threads.id, deletedAt: threads.deletedAt })
        .from(threads)
        .where(inArray(threads.parentThreadId, frontier));
      frontier = [];
      for (const child of children) {
        if (allIds.has(child.id)) continue;
        allIds.add(child.id);
        if (!child.deletedAt) liveIds.add(child.id);
        frontier.push(child.id);
      }
    }

    return {
      threadIds: [...allIds].sort(),
      liveThreadIds: [...liveIds].sort(),
    };
  }

  return {
    transaction<T>(operation: () => Promise<T>): Promise<T> {
      return runInDrizzleTransaction(db, operation);
    },
    readSnapshot<T>(operation: () => Promise<T>): Promise<T> {
      return runInRootDrizzleReadSnapshot(db, operation);
    },
    async lockById(id: WorkId): Promise<Work | null> {
      if (!isUuid(id)) return null;
      await lockWorkLifecycle(db, id);
      return findWorkById(id);
    },
    async create(input: CreateWorkInput): Promise<Work> {
      return runInDrizzleTransaction(db, async () => {
        const id = input.id ?? crypto.randomUUID();
        const activeDb = currentDrizzleDb(db);
        await lockProjectWorkCreation(input.projectId);
        const [project] = await activeDb
          .select()
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        const existingSlugs = await activeDb
          .select({ slug: works.slug })
          .from(works)
          .where(eq(works.projectId, input.projectId));
        let row: WorkRow | undefined;
        try {
          [row] = await activeDb
            .insert(works)
            .values({
              id,
              projectId: input.projectId,
              createdByUserId:
                project?.userId ?? input.createdByUserId ?? "00000000-0000-4000-8000-000000000000",
              name: input.name.trim(),
              slug: nextWorkSlug(
                input.name,
                existingSlugs.map(({ slug }) => slug),
              ),
              goal: input.goal,
            })
            .returning();
        } catch (cause) {
          if (workUniqueConstraint(cause) === "works_project_name_active") {
            throw new WorkNameConflictError();
          }
          throw cause;
        }
        if (!row) throw new Error("Failed to create work");
        await projectionMutation.publishWorks([row.id]);
        return mapWork(row);
      });
    },
    async findById(id: WorkId): Promise<Work | null> {
      // A non-UUID id would reach the `uuid` column and raise a Postgres parse
      // error; treat it as not-found so callers get a clean 404, not a 500.
      return findWorkById(id);
    },
    async findNoWork(projectId: ProjectId): Promise<Work | null> {
      return findNoWorkRow(projectId);
    },
    async ensureNoWork(projectId: ProjectId): Promise<Work> {
      return runInDrizzleTransaction(db, async () => {
        await lockProjectWorkCreation(projectId);
        const existing = await findNoWorkRow(projectId);
        if (existing) return existing;
        const activeDb = currentDrizzleDb(db);
        const [project] = await activeDb
          .select({ userId: projects.userId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project) throw new Error(`Project not found: ${projectId}`);
        await activeDb
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
        const [row] = await activeDb
          .insert(works)
          .values({
            projectId,
            createdByUserId: project.userId,
            name: NO_WORK_NAME,
            slug: null,
            isNoWork: true,
            status: "active",
            aiWriteMode: "direct",
          })
          .returning();
        if (!row) throw new Error("Failed to create No Work");
        return mapWork(row);
      });
    },
    async listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]> {
      const where = and(
        eq(works.projectId, projectId),
        opts?.includeDeleted ? undefined : isNull(works.deletedAt),
        opts?.status ? eq(works.status, opts.status) : undefined,
        opts?.includeNoWork ? undefined : eq(works.isNoWork, false),
      );
      const rows = await currentDrizzleDb(db)
        .select()
        .from(works)
        .where(where)
        .orderBy(desc(works.updatedAt), desc(works.id));
      return rows.map(mapWork);
    },
    async snapshotIdentity(projectId: ProjectId) {
      const [project] = await currentDrizzleDb(db)
        .select({
          authorityRevision: contextAvailabilityHeads.generation,
        })
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`))
        .limit(1);
      const [catalog] = await currentDrizzleDb(db)
        .select({ generation: contextCatalogScopeHeads.generation })
        .from(contextCatalogScopeHeads)
        .where(
          eq(
            contextCatalogScopeHeads.scopeKey,
            catalogScopeKey({ kind: "project", projectId } as never),
          ),
        )
        .limit(1);
      return {
        catalogGeneration: catalog?.generation ?? "00000000-0000-0000-0000-000000000000",
        authorityRevision: String(project?.authorityRevision ?? 0n),
      };
    },
    async update(id: WorkId, input: UpdateWorkInput): Promise<Work> {
      await requireUnlocked(id);
      const patch: Partial<typeof works.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.goal !== undefined) patch.goal = input.goal;
      if (input.status !== undefined) {
        patch.status = input.status;
        patch.archivedAt = input.status === "archived" ? new Date() : null;
      }
      try {
        return await updateWork(id, patch);
      } catch (cause) {
        if (workUniqueConstraint(cause) === "works_project_name_active") {
          throw new WorkNameConflictError();
        }
        throw cause;
      }
    },
    async archive(id: WorkId): Promise<Work> {
      const existing = await requireUnlocked(id);
      if (existing.status === "archived") return existing;
      return updateWork(id, { status: "archived", archivedAt: new Date() });
    },
    async unarchive(id: WorkId): Promise<Work> {
      const existing = await requireUnlocked(id);
      if (existing.status === "active") return existing;
      return updateWork(id, { status: "active", archivedAt: null });
    },
    async hasUnreviewedDraft(id: WorkId): Promise<boolean> {
      if (!isUuid(id)) return false;
      return hasUnreviewedDraft(id);
    },
    async softDelete(id: WorkId) {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        const initialTree = await findPrimaryThreadTree(id);
        for (const threadId of initialTree.threadIds) await lockThreadForMutation(db, threadId);

        const lifecycle = await lockWorkLifecycle(db, id);
        const before = await findWorkById(id);
        if (lifecycle === "missing" || lifecycle === "deleted" || !before) {
          return { before, after: before, threadIds: [] };
        }
        if (before.isNoWork) throw new WorkLockedError();

        const currentTree = await findPrimaryThreadTree(id);
        if (currentTree.threadIds.some((threadId) => !initialTree.threadIds.includes(threadId))) {
          throw new WorkDeleteRetryError();
        }
        const liveThreadIds = currentTree.liveThreadIds;

        const deletedAt = new Date();
        const deletedThreads = liveThreadIds.length
          ? await activeDb
              .update(threads)
              .set({ deletedAt, deletedByWorkId: id, updatedAt: deletedAt })
              .where(and(inArray(threads.id, liveThreadIds), isNull(threads.deletedAt)))
              .returning({ id: threads.id })
          : [];
        if (currentTree.threadIds.length > 0) {
          await activeDb
            .update(projectResults)
            .set({ deletedByWorkId: id })
            .where(
              and(
                or(
                  inArray(projectResults.threadId, currentTree.threadIds),
                  inArray(projectResults.rootThreadId, currentTree.threadIds),
                ),
                isNull(projectResults.deletedByWorkId),
              ),
            );
        }
        const sources = await activeDb
          .select({ id: contextSources.id })
          .from(contextSources)
          .where(and(eq(contextSources.workId, id), isNull(contextSources.deletedAt)));
        const sourceIds = sources.map(({ id: sourceId }) => sourceId);
        if (sourceIds.length > 0) {
          await activeDb
            .update(documents)
            .set({ deletedAt, deletedByWorkId: id })
            .where(and(inArray(documents.contextSourceId, sourceIds), isNull(documents.deletedAt)));
          await activeDb
            .update(folders)
            .set({ deletedAt, deletedByWorkId: id })
            .where(and(inArray(folders.contextSourceId, sourceIds), isNull(folders.deletedAt)));
          await activeDb
            .update(contextSources)
            .set({ deletedAt, deletedByWorkId: id })
            .where(and(inArray(contextSources.id, sourceIds), isNull(contextSources.deletedAt)));
        }
        await activeDb
          .update(documentBranches)
          .set({ status: "closed", deletedByWorkId: id, updatedAt: deletedAt })
          .where(
            and(
              eq(documentBranches.workId, id),
              eq(documentBranches.kind, "work_draft"),
              eq(documentBranches.status, "active"),
            ),
          );
        await activeDb
          .update(works)
          .set({
            deletedAt,
            entityRevision: sql`${works.entityRevision} + 1`,
            updatedAt: deletedAt,
          })
          .where(and(eq(works.id, id), isNull(works.deletedAt)));
        await projectionMutation.publishWorks([id]);
        const after = await findWorkById(id);
        return {
          before,
          after,
          threadIds: deletedThreads.map(({ id: threadId }) => threadId),
        };
      });
    },
    async restore(id: WorkId): Promise<WorkRestoration> {
      try {
        return await runInDrizzleTransaction(db, async () => {
          const activeDb = currentDrizzleDb(db);
          const deletedThreads = await activeDb
            .select({ id: threads.id })
            .from(threads)
            .where(eq(threads.deletedByWorkId, id))
            .orderBy(threads.id);
          for (const { id: threadId } of deletedThreads) {
            await lockThreadForMutation(db, threadId);
          }
          await lockWorkLifecycle(db, id);
          const existing = await findWorkById(id);
          if (!existing) throw new Error(`Work not found: ${id}`);
          if (!existing.deletedAt) {
            return { before: existing, after: existing, changed: false };
          }
          if (workPurgeAt(existing.deletedAt).getTime() <= Date.now()) {
            throw new WorkRestoreExpiredError();
          }
          const restoredAt = new Date();
          const [row] = await currentDrizzleDb(db)
            .update(works)
            .set({
              deletedAt: null,
              entityRevision: sql`${works.entityRevision} + 1`,
              updatedAt: restoredAt,
            })
            .where(eq(works.id, id))
            .returning();
          if (!row) throw new Error(`Work not found: ${id}`);
          await activeDb
            .update(threads)
            .set({ deletedAt: null, deletedByWorkId: null, updatedAt: restoredAt })
            .where(eq(threads.deletedByWorkId, id));
          await activeDb
            .update(projectResults)
            .set({ deletedByWorkId: null })
            .where(eq(projectResults.deletedByWorkId, id));
          await activeDb
            .update(documents)
            .set({ deletedAt: null, deletedByWorkId: null })
            .where(eq(documents.deletedByWorkId, id));
          await activeDb
            .update(folders)
            .set({ deletedAt: null, deletedByWorkId: null })
            .where(eq(folders.deletedByWorkId, id));
          await activeDb
            .update(contextSources)
            .set({ deletedAt: null, deletedByWorkId: null })
            .where(eq(contextSources.deletedByWorkId, id));
          await activeDb
            .update(documentBranches)
            .set({ status: "active", deletedByWorkId: null, updatedAt: restoredAt })
            .where(eq(documentBranches.deletedByWorkId, id));
          await projectionMutation.publishWorks([row.id]);
          return { before: existing, after: mapWork(row), changed: true };
        });
      } catch (cause) {
        const constraint = workUniqueConstraint(cause);
        if (constraint === "works_project_name_active") {
          throw new WorkRestoreConflictError("name");
        }
        if (constraint === "works_project_slug") {
          throw new WorkRestoreConflictError("slug");
        }
        throw cause;
      }
    },
    async touch(id: WorkId): Promise<void> {
      const activeDb = currentDrizzleDb(db);
      const [existing] = await activeDb.select().from(works).where(eq(works.id, id)).limit(1);
      if (!existing || existing.deletedAt) return;
      await projectionMutation.touchWorks([id], new Date());
    },
  };
}
