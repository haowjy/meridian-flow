// @ts-nocheck
/**
 * Drizzle/Postgres implementation of the WorkRepository port. Owns the SQL for
 * the `works` table (creation, listing, soft-delete filtering); depends inward
 * on the port and shares the default-title constant via shared.ts.
 */
import type { WorkbenchId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
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
    workbenchId: row.workbenchId,
    title: row.title,
    description: row.description,
    status: row.status as Work["status"],
    visibility: row.visibility as Work["visibility"],
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export interface DrizzleWorkRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link WorkRepository} over the `schema` works table. */
export function createDrizzleWorkRepository(deps: DrizzleWorkRepositoryDeps): WorkRepository {
  const { db } = deps;

  const repo: WorkRepository = {
    async create(input: CreateWorkInput): Promise<Work> {
      const id = input.id ?? crypto.randomUUID();
      const [row] = await db
        .insert(works)
        .values({
          id,
          workbenchId: input.workbenchId,
          title: input.title?.trim() || DEFAULT_WORK_TITLE,
          description: input.description ?? null,
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
        ? eq(works.workbenchId, workbenchId)
        : and(eq(works.workbenchId, workbenchId), isNull(works.deletedAt));
      const rows = await db.select().from(works).where(where).orderBy(desc(works.lastActivityAt));
      return rows.map(mapWork);
    },

    async ensureDefaultForWorkbench(workbenchId: WorkbenchId, title?: string): Promise<Work> {
      const [existing] = await db
        .select()
        .from(works)
        .where(
          and(
            eq(works.workbenchId, workbenchId),
            eq(works.isDefault, true),
            isNull(works.deletedAt),
            eq(works.status, "active"),
          ),
        )
        .orderBy(desc(works.lastActivityAt))
        .limit(1);
      if (existing) return mapWork(existing);

      const id = crypto.randomUUID();
      const [created] = await db
        .insert(works)
        .values({
          id,
          workbenchId,
          title: title?.trim() || DEFAULT_WORK_TITLE,
          description: null,
          isDefault: true,
        })
        .onConflictDoNothing({
          target: works.workbenchId,
          where: sql`${works.isDefault} = true AND ${works.deletedAt} IS NULL AND ${works.status} = 'active'`,
        })
        .returning();
      if (created) return mapWork(created);

      const [row] = await db
        .select()
        .from(works)
        .where(
          and(
            eq(works.workbenchId, workbenchId),
            eq(works.isDefault, true),
            isNull(works.deletedAt),
            eq(works.status, "active"),
          ),
        )
        .limit(1);
      if (!row) throw new Error(`Default work not found for workbench: ${workbenchId}`);
      return mapWork(row);
    },

    async touch(id: WorkId): Promise<void> {
      const [existing] = await db.select().from(works).where(eq(works.id, id)).limit(1);
      if (!existing || existing.deletedAt) return;
      const now = new Date().toISOString();
      await db.update(works).set({ lastActivityAt: now, updatedAt: now }).where(eq(works.id, id));
    },
  };

  return repo;
}
