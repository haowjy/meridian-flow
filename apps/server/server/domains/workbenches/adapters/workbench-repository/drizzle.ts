// @ts-nocheck
import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import type { Workbench } from "@meridian/contracts/workbenches";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database/schema";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type {
  CreateWorkbenchInput,
  ListWorkbenchesOptions,
  UpdateWorkbenchInput,
  WorkbenchRepository,
} from "../../ports/workbench-repository.js";
import { DEFAULT_WORKBENCH_TITLE, deriveSlug } from "./shared.js";

type ProjectRow = typeof projects.$inferSelect;
function mapWorkbench(row: ProjectRow): Workbench {
  return {
    id: row.id,
    userId: row.userId,
    title: row.name,
    name: row.name,
    slug: row.slug,
    description: row.systemPrompt,
    systemPrompt: row.systemPrompt,
    isPersonal: row.isPersonal,
    settings: row.settings,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
export interface DrizzleWorkbenchRepositoryDeps {
  db: Database;
}
export function createDrizzleWorkbenchRepository(
  deps: DrizzleWorkbenchRepositoryDeps,
): WorkbenchRepository {
  const { db } = deps;
  return {
    async create(input: CreateWorkbenchInput): Promise<Workbench> {
      const id = input.id ?? crypto.randomUUID();
      const title = input.title?.trim() || DEFAULT_WORKBENCH_TITLE;
      const [row] = await db
        .insert(projects)
        .values({
          id,
          userId: input.userId,
          name: title,
          slug: deriveSlug(title, id),
          isPersonal: false,
          systemPrompt: input.description ?? null,
        })
        .returning();
      if (!row) throw new Error("Failed to create workbench");
      return mapWorkbench(row);
    },
    async findById(id: WorkbenchId): Promise<Workbench | null> {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return row ? mapWorkbench(row) : null;
    },
    async listByUser(userId: UserId, opts?: ListWorkbenchesOptions): Promise<Workbench[]> {
      const where = opts?.includeDeleted
        ? eq(projects.userId, userId)
        : and(eq(projects.userId, userId), isNull(projects.deletedAt));
      const rows = await db
        .select()
        .from(projects)
        .where(where)
        .orderBy(desc(projects.lastActivityAt));
      return rows.map(mapWorkbench);
    },
    async search(userId: UserId, query: string): Promise<Workbench[]> {
      const pattern = `%${query}%`;
      const rows = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.userId, userId),
            isNull(projects.deletedAt),
            or(ilike(projects.name, pattern), ilike(projects.systemPrompt, pattern)),
          ),
        )
        .orderBy(desc(projects.lastActivityAt));
      return rows.map(mapWorkbench);
    },
    async update(id: WorkbenchId, input: UpdateWorkbenchInput): Promise<Workbench> {
      const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.name = input.title;
      if (input.description !== undefined) patch.systemPrompt = input.description;
      const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },
    async softDelete(id: WorkbenchId): Promise<Workbench> {
      const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!existing) throw new Error(`Workbench not found: ${id}`);
      if (existing.deletedAt) return mapWorkbench(existing);
      const now = new Date();
      const [row] = await db
        .update(projects)
        .set({ deletedAt: now, updatedAt: now, lastActivityAt: now })
        .where(eq(projects.id, id))
        .returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },
    async restore(id: WorkbenchId): Promise<Workbench> {
      const [row] = await db
        .update(projects)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      if (!row) throw new Error(`Workbench not found: ${id}`);
      return mapWorkbench(row);
    },
    async touch(id: WorkbenchId): Promise<void> {
      const [workbench] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!workbench || workbench.deletedAt) return;
      const now = new Date();
      await db
        .update(projects)
        .set({ updatedAt: now, lastActivityAt: now })
        .where(eq(projects.id, id));
    },
  };
}
