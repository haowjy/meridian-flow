// @ts-nocheck
/**
 * Drizzle/Postgres implementation of the WorkbenchRepository port. Owns the SQL
 * for the `workbenches` table (slug derivation, soft-delete filtering, search);
 * depends inward on the port and shares title/slug helpers via shared.ts.
 */

import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import type { Workbench } from "@meridian/contracts/workbenches";
import type { Database } from "@meridian/database";
import { workbenches } from "@meridian/database/schema";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type {
  CreateWorkbenchInput,
  ListWorkbenchesOptions,
  UpdateWorkbenchInput,
  WorkbenchRepository,
} from "../../ports/workbench-repository.js";
import { DEFAULT_WORKBENCH_TITLE, deriveSlug } from "./shared.js";

type WorkbenchRow = typeof workbenches.$inferSelect;

function mapWorkbench(row: WorkbenchRow): Workbench {
  return {
    id: row.id,
    userId: row.createdBy,
    title: row.title,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export interface DrizzleWorkbenchRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link WorkbenchRepository} over the `schema` workbenches table. */
export function createDrizzleWorkbenchRepository(
  deps: DrizzleWorkbenchRepositoryDeps,
): WorkbenchRepository {
  const { db } = deps;

  return {
    async create(input: CreateWorkbenchInput): Promise<Workbench> {
      const id = input.id ?? crypto.randomUUID();
      const title = input.title?.trim() || DEFAULT_WORKBENCH_TITLE;
      const [row] = await db
        .insert(workbenches)
        .values({
          id,
          title,
          slug: deriveSlug(title, id),
          description: input.description ?? null,
          createdBy: input.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create workbench");
      return mapWorkbench(row);
    },

    async findById(id: WorkbenchId): Promise<Workbench | null> {
      const [row] = await db.select().from(workbenches).where(eq(workbenches.id, id)).limit(1);
      return row ? mapWorkbench(row) : null;
    },

    async listByUser(userId: UserId, opts?: ListWorkbenchesOptions): Promise<Workbench[]> {
      const where = opts?.includeDeleted
        ? eq(workbenches.createdBy, userId)
        : and(eq(workbenches.createdBy, userId), isNull(workbenches.deletedAt));
      const rows = await db
        .select()
        .from(workbenches)
        .where(where)
        .orderBy(desc(workbenches.lastActivityAt));
      return rows.map(mapWorkbench);
    },

    async search(userId: UserId, query: string): Promise<Workbench[]> {
      const pattern = `%${query}%`;
      const rows = await db
        .select()
        .from(workbenches)
        .where(
          and(
            eq(workbenches.createdBy, userId),
            isNull(workbenches.deletedAt),
            or(ilike(workbenches.title, pattern), ilike(workbenches.description, pattern)),
          ),
        )
        .orderBy(desc(workbenches.lastActivityAt));
      return rows.map(mapWorkbench);
    },

    async update(id: WorkbenchId, input: UpdateWorkbenchInput): Promise<Workbench> {
      const patch: Partial<typeof workbenches.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      const [row] = await db
        .update(workbenches)
        .set(patch)
        .where(eq(workbenches.id, id))
        .returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },

    async softDelete(id: WorkbenchId): Promise<Workbench> {
      const [existing] = await db.select().from(workbenches).where(eq(workbenches.id, id)).limit(1);
      if (!existing) throw new Error(`Workbench not found: ${id}`);
      if (existing.deletedAt) return mapWorkbench(existing);
      const now = new Date().toISOString();
      const [row] = await db
        .update(workbenches)
        .set({ deletedAt: now, updatedAt: now, lastActivityAt: now })
        .where(eq(workbenches.id, id))
        .returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },

    async restore(id: WorkbenchId): Promise<Workbench> {
      const [row] = await db
        .update(workbenches)
        .set({ deletedAt: null, updatedAt: new Date().toISOString() })
        .where(eq(workbenches.id, id))
        .returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },

    async touch(id: WorkbenchId): Promise<void> {
      const [workbench] = await db
        .select()
        .from(workbenches)
        .where(eq(workbenches.id, id))
        .limit(1);
      if (!workbench || workbench.deletedAt) return;
      const now = new Date().toISOString();
      await db
        .update(workbenches)
        .set({ updatedAt: now, lastActivityAt: now })
        .where(eq(workbenches.id, id));
    },
  };
}
