// @ts-nocheck
import type { WorkbenchId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { projects, works } from "@meridian/database/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  CreateWorkInput,
  ListWorksOptions,
  WorkRepository,
} from "../../ports/work-repository.js";
import { DEFAULT_WORK_TITLE } from "./shared.js";

type WorkRow = typeof works.$inferSelect;
function mapWork(row: WorkRow): Work {
  return {
    id: row.id,
    workbenchId: row.projectId,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    description: null,
    status: row.deletedAt ? "archived" : "active",
    visibility: row.visibility,
    lastActivityAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
export interface DrizzleWorkRepositoryDeps {
  db: Database;
}
export function createDrizzleWorkRepository(deps: DrizzleWorkRepositoryDeps): WorkRepository {
  const { db } = deps;
  return {
    async create(input: CreateWorkInput): Promise<Work> {
      const id = input.id ?? crypto.randomUUID();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.workbenchId))
        .limit(1);
      const [row] = await db
        .insert(works)
        .values({
          id,
          projectId: input.workbenchId,
          createdByUserId:
            project?.userId ?? input.createdByUserId ?? "00000000-0000-4000-8000-000000000000",
          title: input.title?.trim() || DEFAULT_WORK_TITLE,
        })
        .returning();
      if (!row) throw new Error("Failed to create work");
      return mapWork(row);
    },
    async findById(id: WorkId): Promise<Work | null> {
      const [row] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      return row ? mapWork(row) : null;
    },
    async listByWorkbench(workbenchId: WorkbenchId, opts?: ListWorksOptions): Promise<Work[]> {
      const where = opts?.includeDeleted
        ? eq(works.projectId, workbenchId)
        : and(eq(works.projectId, workbenchId), isNull(works.deletedAt));
      const rows = await db.select().from(works).where(where).orderBy(desc(works.updatedAt));
      return rows.map(mapWork);
    },
    async ensureDefaultForWorkbench(workbenchId: WorkbenchId, title?: string): Promise<Work> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workbenchId}, 42::bigint))`,
        );
        const [existing] = await tx
          .select()
          .from(works)
          .where(and(eq(works.projectId, workbenchId), isNull(works.deletedAt)))
          .orderBy(desc(works.updatedAt))
          .limit(1);
        if (existing) return mapWork(existing);
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, workbenchId))
          .limit(1);
        const [created] = await tx
          .insert(works)
          .values({
            projectId: workbenchId,
            createdByUserId: project?.userId,
            title: title?.trim() || DEFAULT_WORK_TITLE,
          })
          .returning();
        if (!created) throw new Error(`Default work not found for workbench: ${workbenchId}`);
        return mapWork(created);
      });
    },
    async touch(id: WorkId): Promise<void> {
      const [existing] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      if (!existing || existing.deletedAt) return;
      await db.update(works).set({ updatedAt: new Date() }).where(eq(works.id, id));
    },
  };
}
