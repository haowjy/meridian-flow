import { catalogScopeKey } from "@meridian/contracts/protocol";
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import {
  type AiWriteMode,
  decodeWorkSlug,
  type Work,
  type WorkStatus,
} from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextCatalogScopeHeads,
  contextSources,
  documents,
  folders,
  projects,
  threads,
  threadWorks,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../../shared/uuid.js";
import { lockWorkLifecycle } from "../../../../shared/work-lifecycle-lock.js";
import type {
  CreateWorkInput,
  ListWorksOptions,
  UpdateWorkInput,
  WorkRepository,
} from "../../ports/work-repository.js";
import {
  WorkDeleteBlockedError,
  WorkNameConflictError,
  WorkRestoreConflictError,
} from "../../ports/work-repository.js";
import type { WorkProjectionMutation } from "../work-projection-mutation.js";
import { nextWorkSlug } from "./shared.js";

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
  const slug = decodeWorkSlug(row.slug);
  if (!slug) throw new Error(`Persisted Work ${row.id} has an invalid slug`);
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    slug,
    goal: row.goal,
    description: row.description,
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
          .where(and(eq(works.projectId, input.projectId), isNull(works.deletedAt)));
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
              description: input.description,
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
    async listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]> {
      const where = and(
        eq(works.projectId, projectId),
        opts?.includeDeleted ? undefined : isNull(works.deletedAt),
        opts?.status ? eq(works.status, opts.status) : undefined,
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
      const patch: Partial<typeof works.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.goal !== undefined) patch.goal = input.goal;
      if (input.description !== undefined) patch.description = input.description;
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
      const existing = await findWorkById(id);
      if (!existing || existing.deletedAt) throw new Error(`Work not found: ${id}`);
      if (existing?.status === "archived") return existing;
      return updateWork(id, { status: "archived", archivedAt: new Date() });
    },
    async unarchive(id: WorkId): Promise<Work> {
      const existing = await findWorkById(id);
      if (!existing || existing.deletedAt) throw new Error(`Work not found: ${id}`);
      if (existing?.status === "active") return existing;
      return updateWork(id, { status: "active", archivedAt: null });
    },
    async hasUnreviewedDraft(id: WorkId): Promise<boolean> {
      if (!isUuid(id)) return false;
      return hasUnreviewedDraft(id);
    },
    async softDelete(id: WorkId): Promise<void> {
      const existing = await findWorkById(id);
      if (!existing || existing.deletedAt) return;

      await runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        if ((await lockWorkLifecycle(db, id)) !== "active") return;
        if (await hasUnreviewedDraft(id)) throw new WorkDeleteBlockedError("drafts");

        const [membership] = await activeDb
          .select({ threadId: threadWorks.threadId })
          .from(threadWorks)
          .innerJoin(threads, eq(threadWorks.threadId, threads.id))
          .where(and(eq(threadWorks.workId, id), isNull(threads.deletedAt)))
          .limit(1);
        if (membership) throw new WorkDeleteBlockedError("threads");

        const [document] = await activeDb
          .select({ id: documents.id })
          .from(contextSources)
          .innerJoin(documents, eq(documents.contextSourceId, contextSources.id))
          .where(
            and(
              eq(contextSources.workId, id),
              isNull(documents.deletedAt),
              eq(documents.kind, "content"),
            ),
          )
          .limit(1);
        if (document) throw new WorkDeleteBlockedError("documents");

        const [folder] = await activeDb
          .select({ id: folders.id })
          .from(contextSources)
          .innerJoin(folders, eq(folders.contextSourceId, contextSources.id))
          .where(and(eq(contextSources.workId, id), isNull(folders.deletedAt)))
          .limit(1);
        if (folder) throw new WorkDeleteBlockedError("folders");

        await activeDb
          .update(works)
          .set({
            deletedAt: new Date(),
            entityRevision: sql`${works.entityRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(works.id, id), isNull(works.deletedAt)));
        await projectionMutation.publishWorks([id]);
      });
    },
    async restore(id: WorkId): Promise<Work> {
      const existing = await findWorkById(id);
      if (!existing) throw new Error(`Work not found: ${id}`);
      if (!existing.deletedAt) return existing;
      try {
        return await runInDrizzleTransaction(db, async () => {
          await lockWorkLifecycle(db, id);
          const [row] = await currentDrizzleDb(db)
            .update(works)
            .set({
              deletedAt: null,
              entityRevision: sql`${works.entityRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(works.id, id))
            .returning();
          if (!row) throw new Error(`Work not found: ${id}`);
          await projectionMutation.publishWorks([row.id]);
          return mapWork(row);
        });
      } catch (cause) {
        const constraint = workUniqueConstraint(cause);
        if (constraint === "works_project_name_active") {
          throw new WorkRestoreConflictError("name");
        }
        if (constraint === "works_project_slug_active") {
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
