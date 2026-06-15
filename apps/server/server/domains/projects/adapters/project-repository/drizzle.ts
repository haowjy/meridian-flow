import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database/schema";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type {
  CreateProjectInput,
  ListProjectsOptions,
  ProjectRepository,
  UpdateProjectInput,
} from "../../ports/project-repository.js";
import { DEFAULT_PROJECT_TITLE, deriveSlug } from "./shared.js";

type ProjectRow = typeof projects.$inferSelect;
function mapProject(row: ProjectRow): Project {
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
export interface DrizzleProjectRepositoryDeps {
  db: Database;
}
export function createDrizzleProjectRepository(
  deps: DrizzleProjectRepositoryDeps,
): ProjectRepository {
  const { db } = deps;
  return {
    async create(input: CreateProjectInput): Promise<Project> {
      const id = input.id ?? crypto.randomUUID();
      const title = input.title?.trim() || DEFAULT_PROJECT_TITLE;
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
      if (!row) throw new Error("Failed to create project");
      return mapProject(row);
    },
    async findById(id: ProjectId): Promise<Project | null> {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return row ? mapProject(row) : null;
    },
    async listByUser(userId: UserId, opts?: ListProjectsOptions): Promise<Project[]> {
      const where = opts?.includeDeleted
        ? eq(projects.userId, userId)
        : and(eq(projects.userId, userId), isNull(projects.deletedAt));
      const rows = await db
        .select()
        .from(projects)
        .where(where)
        .orderBy(desc(projects.lastActivityAt));
      return rows.map(mapProject);
    },
    async search(userId: UserId, query: string): Promise<Project[]> {
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
      return rows.map(mapProject);
    },
    async update(id: ProjectId, input: UpdateProjectInput): Promise<Project> {
      const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.name = input.title;
      if (input.description !== undefined) patch.systemPrompt = input.description;
      const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
      if (!row) throw new Error(`Project not found: ${id}`);
      return mapProject(row);
    },
    async softDelete(id: ProjectId): Promise<Project> {
      const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!existing) throw new Error(`Project not found: ${id}`);
      if (existing.deletedAt) return mapProject(existing);
      const now = new Date();
      const [row] = await db
        .update(projects)
        .set({ deletedAt: now, updatedAt: now, lastActivityAt: now })
        .where(eq(projects.id, id))
        .returning();
      if (!row) throw new Error(`Project not found: ${id}`);
      return mapProject(row);
    },
    async restore(id: ProjectId): Promise<Project> {
      const [row] = await db
        .update(projects)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      if (!row) throw new Error(`Project not found: ${id}`);
      return mapProject(row);
    },
    async touch(id: ProjectId): Promise<void> {
      const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!project || project.deletedAt) return;
      const now = new Date();
      await db
        .update(projects)
        .set({ updatedAt: now, lastActivityAt: now })
        .where(eq(projects.id, id));
    },
  };
}
