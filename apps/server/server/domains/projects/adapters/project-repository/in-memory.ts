// @ts-nocheck
/** In-memory ProjectRepository for tests: Map-backed project CRUD implementing the port. Shares default-title/slug behavior with the drizzle adapter via shared.ts. */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type {
  CreateProjectInput,
  ListProjectsOptions,
  ProjectRepository,
  UpdateProjectInput,
} from "../../ports/project-repository.js";
import { DEFAULT_PROJECT_TITLE } from "./shared.js";

/** In-memory {@link ProjectRepository} for tests. */
export function createInMemoryProjectRepository(): ProjectRepository {
  const rows = new Map<string, Project>();

  function now(): string {
    return new Date().toISOString();
  }

  return {
    async create(input: CreateProjectInput): Promise<Project> {
      const timestamp = now();
      const project: Project = {
        id: input.id ?? crypto.randomUUID(),
        userId: input.userId,
        title: input.title?.trim() || DEFAULT_PROJECT_TITLE,
        description: input.description ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      rows.set(project.id, project);
      return { ...project };
    },

    async findById(id: ProjectId): Promise<Project | null> {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },

    async listByUser(userId: UserId, opts?: ListProjectsOptions): Promise<Project[]> {
      return [...rows.values()]
        .filter((p) => p.userId === userId && (opts?.includeDeleted || p.deletedAt === null))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => ({ ...p }));
    },

    async search(userId: UserId, query: string): Promise<Project[]> {
      const q = query.toLowerCase();
      return [...rows.values()]
        .filter(
          (p) =>
            p.userId === userId &&
            p.deletedAt === null &&
            (p.title.toLowerCase().includes(q) ||
              (p.description?.toLowerCase().includes(q) ?? false)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({ ...p }));
    },

    async update(id: ProjectId, input: UpdateProjectInput): Promise<Project> {
      const row = rows.get(id);
      if (!row) throw new Error(`Project not found: ${id}`);
      if (input.title !== undefined) row.title = input.title;
      if (input.description !== undefined) row.description = input.description;
      row.updatedAt = now();
      return { ...row };
    },

    async softDelete(id: ProjectId): Promise<Project> {
      const row = rows.get(id);
      if (!row) throw new Error(`Project not found: ${id}`);
      if (row.deletedAt === null) row.deletedAt = now();
      return { ...row };
    },

    async restore(id: ProjectId): Promise<Project> {
      const row = rows.get(id);
      if (!row) throw new Error(`Project not found: ${id}`);
      row.deletedAt = null;
      return { ...row };
    },

    async touch(id: ProjectId): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      row.updatedAt = now();
    },
  };
}
