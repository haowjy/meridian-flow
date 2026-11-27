import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database/schema";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { lockProjectLifecycleExclusive } from "../../../../shared/project-lifecycle-lock.js";
import { isUuid } from "../../../../shared/uuid.js";
import { provisionProjectSources } from "../../../context/index.js";
import type { FileAccessChanges } from "../../../file-policy/index.js";
import type {
  CreateProjectInput,
  ListProjectsOptions,
  ProjectRepository,
} from "../../ports/project-repository.js";
import { DEFAULT_PROJECT_TITLE, nextProjectSlug } from "./shared.js";

type ProjectRow = typeof projects.$inferSelect;
function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    slug: row.slug,
    systemPrompt: row.systemPrompt,
    settings: row.settings,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
export async function lockUserProjects(db: Database, userId: UserId): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`,
  );
}

export interface DrizzleProjectRepositoryDeps {
  db: Database;
  fileAccessChanges: Pick<FileAccessChanges, "publish">;
  ensureNoWork: (projectId: ProjectId) => Promise<unknown>;
}
export function createDrizzleProjectRepository(
  deps: DrizzleProjectRepositoryDeps,
): ProjectRepository {
  const { db } = deps;
  return {
    async create(input: CreateProjectInput): Promise<Project> {
      return runInDrizzleTransaction(db, async () => {
        const id = input.id ?? crypto.randomUUID();
        const title = input.title?.trim() || DEFAULT_PROJECT_TITLE;
        const tx = currentDrizzleDb(db);
        await lockUserProjects(db, input.userId);
        const reserved = await tx
          .select({ slug: projects.slug })
          .from(projects)
          .where(eq(projects.userId, input.userId));
        const [row] = await tx
          .insert(projects)
          .values({
            id,
            userId: input.userId,
            name: title,
            slug: nextProjectSlug(
              title,
              reserved.map((row) => row.slug),
            ),
            systemPrompt: input.description ?? null,
          })
          .returning();
        if (!row) throw new Error("Failed to create project");
        await provisionProjectSources(db, row.id);
        await deps.ensureNoWork(row.id);
        return mapProject(row);
      });
    },
    async findById(id: ProjectId): Promise<Project | null> {
      if (!isUuid(id)) return null;
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      return row ? mapProject(row) : null;
    },
    async findLiveByOwnerSlug(userId: UserId, slug: string): Promise<Project | null> {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(projects)
        .where(
          and(eq(projects.userId, userId), eq(projects.slug, slug), isNull(projects.deletedAt)),
        )
        .limit(1);
      return row ? mapProject(row) : null;
    },
    async listByUser(userId: UserId, opts?: ListProjectsOptions): Promise<Project[]> {
      const where = opts?.includeDeleted
        ? eq(projects.userId, userId)
        : and(eq(projects.userId, userId), isNull(projects.deletedAt));
      const rows = await currentDrizzleDb(db)
        .select()
        .from(projects)
        .where(where)
        .orderBy(desc(projects.lastActivityAt));
      return rows.map(mapProject);
    },
    async search(userId: UserId, query: string): Promise<Project[]> {
      const pattern = `%${query}%`;
      const rows = await currentDrizzleDb(db)
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
    async rename(id: ProjectId, title: string): Promise<Project> {
      const [row] = await currentDrizzleDb(db)
        .update(projects)
        .set({ name: title, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      if (!row) throw new Error(`Project not found: ${id}`);
      return mapProject(row);
    },
    async softDelete(id: ProjectId): Promise<Project> {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        await lockProjectLifecycleExclusive(db, id);
        const [existing] = await activeDb
          .select()
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1);
        if (!existing) throw new Error(`Project not found: ${id}`);
        if (existing.deletedAt) return mapProject(existing);
        const now = new Date();
        const [row] = await activeDb
          .update(projects)
          .set({ deletedAt: now, updatedAt: now, lastActivityAt: now })
          .where(eq(projects.id, id))
          .returning();
        if (!row) throw new Error(`Project not found: ${id}`);
        await deps.fileAccessChanges.publish({ projectId: row.id });
        return mapProject(row);
      });
    },
    async restore(id: ProjectId): Promise<Project> {
      return runInDrizzleTransaction(db, async () => {
        await lockProjectLifecycleExclusive(db, id);
        const [row] = await currentDrizzleDb(db)
          .update(projects)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning();
        if (!row) throw new Error(`Project not found: ${id}`);
        return mapProject(row);
      });
    },
  };
}
