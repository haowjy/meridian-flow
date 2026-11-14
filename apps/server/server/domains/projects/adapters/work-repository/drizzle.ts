import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import {
  type AiWriteMode,
  decodeWorkHandle,
  formatWorkHandle,
  type Work,
} from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { contextSources, projects, treeNodes, works } from "@meridian/database/schema";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../../shared/drizzle-transaction.js";
import { allocateHandleNumber } from "../../../../shared/handle-counter.js";
import { lockWorkThreadTree } from "../../../../shared/thread-work-lock.js";
import { lockProjectTreeList } from "../../../../shared/tree-list-lock.js";
import { isUuid } from "../../../../shared/uuid.js";
import { lockWorkLifecycle } from "../../../../shared/work-lifecycle-lock.js";
import { type LineageScratchLifecycle, provisionWorkScratch } from "../../../context/index.js";
import type { DocumentArrivals } from "../../../context/ports/document-arrivals.js";
import type { FileAccessChanges } from "../../../file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../../domain/work-lifecycle.js";
import { decideWorkRestore } from "../../domain/work-restore.js";
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
} from "../../ports/work-repository.js";
import { cascadeDelete, cascadeRestore } from "../work-cascade.js";
import type { WorkProjectionMutation } from "../work-projection-mutation.js";
import { NO_WORK_NAME } from "./shared.js";

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
  const handle = row.isNoWork ? null : decodeWorkHandle(row.handle);
  if (!row.isNoWork && !handle) throw new Error(`Persisted Work ${row.id} has an invalid handle`);
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    handle,
    isNoWork: row.isNoWork,
    goal: row.goal,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    defaultAiWriteMode: row.defaultAiWriteMode,
    entityRevision: String(row.entityRevision),
    pendingDocumentCount: row.pendingDocumentCount,
    lastActivityAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
export interface DrizzleWorkRepositoryDeps {
  db: Database;
  projectionMutation: WorkProjectionMutation;
  /**
   * Each lifecycle change re-decides the Work's own files' access (file-access §7) and wakes
   * the project's Works list (`projectionMutation.lifecycleChanged`).
   */
  fileAccessChanges: Pick<FileAccessChanges, "publish">;
  lineageScratch: LineageScratchLifecycle;
  /** Restored documents arrive at their addresses (contract §9.3). */
  arrivals?: Pick<DocumentArrivals, "lockNamespaces" | "settle">;
  now?: () => Date;
}
export function createDrizzleWorkRepository(deps: DrizzleWorkRepositoryDeps): WorkRepository {
  const { db } = deps;
  const lineageScratch = deps.lineageScratch;
  const projectionMutation = deps.projectionMutation;
  const now = deps.now ?? (() => new Date());

  /** The documents the list shows in the Work's own sources: they arrive again with the Work. */
  async function workSourceDocumentIds(workId: WorkId): Promise<DocumentId[]> {
    const rows = await currentDrizzleDb(db)
      .select({ id: treeNodes.id })
      .from(treeNodes)
      .innerJoin(contextSources, eq(contextSources.id, treeNodes.contextSourceId))
      .where(
        and(
          eq(contextSources.workId, workId),
          eq(treeNodes.kind, "document"),
          isNull(treeNodes.trashRecord),
        ),
      );
    return rows.map((row) => row.id as DocumentId);
  }

  async function lifecycleChanged(work: Pick<Work, "id" | "projectId">): Promise<void> {
    await deps.fileAccessChanges.publish({ workId: work.id as WorkId });
    projectionMutation.lifecycleChanged({ id: work.id as WorkId, projectId: work.projectId });
  }

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
    if (!existing) throw new WorkLifecycleUnavailableError(id, "missing");
    if (existing.deletedAt) {
      throw new WorkLifecycleUnavailableError(id, "deleted", existing.handle);
    }
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
      return mapWork(row);
    });
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
        const handle = formatWorkHandle(
          await allocateHandleNumber(activeDb, input.projectId, "work"),
        );
        let row: WorkRow | undefined;
        try {
          [row] = await activeDb
            .insert(works)
            .values({
              id,
              projectId: input.projectId,
              createdByUserId:
                project?.userId ?? input.createdByUserId ?? "00000000-0000-4000-8000-000000000000",
              name: input.name,
              handle,
              goal: input.goal ?? null,
            })
            .returning();
        } catch (cause) {
          if (workUniqueConstraint(cause) === "works_project_name_active") {
            throw new WorkNameConflictError();
          }
          throw cause;
        }
        if (!row) throw new Error("Failed to create work");
        await provisionWorkScratch(db, row.id);
        return mapWork(row);
      });
    },
    async findById(id: WorkId): Promise<Work | null> {
      // A non-UUID id would reach the `uuid` column and raise a Postgres parse
      // error; treat it as not-found so callers get a clean 404, not a 500.
      return findWorkById(id);
    },
    async findByHandle(projectId: ProjectId, handle: string): Promise<Work | null> {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(works)
        .where(and(eq(works.projectId, projectId), eq(works.handle, handle)))
        .limit(1);
      return row ? mapWork(row) : null;
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
            handle: null,
            isNoWork: true,
            defaultAiWriteMode: "direct",
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
        (opts?.lifecycle ?? "active") === "all"
          ? undefined
          : opts?.lifecycle === "archived"
            ? sql`${works.archivedAt} IS NOT NULL`
            : isNull(works.archivedAt),
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
      // Every Work change raises that Work's revision and none lowers it, so the sum orders
      // snapshots of the project. Read in the snapshot's own transaction, beside the Works.
      const [project] = await currentDrizzleDb(db)
        .select({ revision: sql<string>`coalesce(sum(${works.entityRevision}), 0)::text` })
        .from(works)
        .where(eq(works.projectId, projectId));
      return { authorityRevision: project?.revision ?? "0" };
    },
    async update(id: WorkId, input: UpdateWorkInput): Promise<Work> {
      await requireUnlocked(id);
      const patch: Partial<typeof works.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.goal !== undefined) patch.goal = input.goal;
      if (input.status !== undefined) patch.status = input.status;
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
      return runInDrizzleTransaction(db, async () => {
        const existing = await requireUnlocked(id);
        if (existing.archivedAt !== null) return existing;
        await lockProjectTreeList(db, existing.projectId);
        const archived = await updateWork(id, { archivedAt: new Date() });
        await lifecycleChanged(archived);
        return archived;
      });
    },
    async unarchive(id: WorkId): Promise<Work> {
      return runInDrizzleTransaction(db, async () => {
        const existing = await requireUnlocked(id);
        if (existing.archivedAt === null) return existing;
        await lockProjectTreeList(db, existing.projectId);
        const unarchived = await updateWork(id, { archivedAt: null });
        await lifecycleChanged(unarchived);
        return unarchived;
      });
    },
    async softDelete(id: WorkId, endThreads) {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        const lockedTree = await lockWorkThreadTree(db, id, { beforeLock: endThreads });
        const before = await findWorkById(id);
        if (lockedTree.lifecycle === "missing" || lockedTree.lifecycle === "deleted" || !before) {
          return { before, after: before };
        }
        if (before.isNoWork) throw new WorkLockedError();
        if (lockedTree.changed) throw new WorkDeleteRetryError();
        await lockProjectTreeList(db, before.projectId);

        const deletedAt = now();
        await cascadeDelete(db, {
          projectId: before.projectId,
          workId: id,
          threadIds: lockedTree.threadIds,
          liveThreadIds: lockedTree.liveThreadIds,
          at: deletedAt,
        });
        await activeDb
          .update(works)
          .set({
            deletedAt,
            entityRevision: sql`${works.entityRevision} + 1`,
            updatedAt: deletedAt,
          })
          .where(and(eq(works.id, id), isNull(works.deletedAt)));
        await lifecycleChanged(before);
        const after = await findWorkById(id);
        await lineageScratch.reconcile(lockedTree.threadIds);
        return { before, after };
      });
    },
    async restore(id: WorkId): Promise<WorkRestoration> {
      try {
        return await runInDrizzleTransaction(db, async () => {
          const lockedTree = await lockWorkThreadTree(db, id, { includeMarked: true });
          const existing = await findWorkById(id);
          if (!existing) throw new Error(`Work not found: ${id}`);
          if (decideWorkRestore(existing, now()) === "unchanged") {
            return { before: existing, after: existing, changed: false };
          }
          // Thread forest → Work above, then the project's tree list and the namespaces the
          // restore re-occupies, before any row reappears (contract §9.3). Individually deleted
          // rows stay deleted.
          await lockProjectTreeList(db, existing.projectId);
          const arriving = deps.arrivals ? await workSourceDocumentIds(id) : [];
          if (arriving.length > 0) await deps.arrivals?.lockNamespaces(arriving);
          const restoredAt = now();
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
          await cascadeRestore(db, {
            projectId: existing.projectId,
            workId: id,
            threadIds: lockedTree.threadIds,
            liveThreadIds: lockedTree.liveThreadIds,
            at: restoredAt,
          });
          // The Work's drafts and Scratch are in view again, so its pending count moved.
          projectionMutation.recountAfterCommit({ workIds: [id], lineageRootIds: [] });
          await lineageScratch.reconcile(lockedTree.threadIds);
          if (arriving.length > 0) await deps.arrivals?.settle(arriving);
          await lifecycleChanged(existing);
          return { before: existing, after: mapWork(row), changed: true };
        });
      } catch (cause) {
        const constraint = workUniqueConstraint(cause);
        if (constraint === "works_project_name_active") {
          throw new WorkRestoreConflictError();
        }
        throw cause;
      }
    },
    async setDefaultAiWriteMode(id: WorkId, mode: AiWriteMode): Promise<void> {
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .update(works)
          .set({
            defaultAiWriteMode: mode,
            entityRevision: sql`${works.entityRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(works.id, id), ne(works.defaultAiWriteMode, mode)));
      });
    },
    async touch(id: WorkId): Promise<void> {
      const activeDb = currentDrizzleDb(db);
      const [existing] = await activeDb.select().from(works).where(eq(works.id, id)).limit(1);
      if (!existing || existing.deletedAt) return;
      await projectionMutation.touchWorks([id], new Date());
    },
  };
}
