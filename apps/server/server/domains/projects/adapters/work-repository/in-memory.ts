/** In-memory WorkRepository for tests: Map-backed work CRUD implementing the port. Shares the default-title constant with the drizzle adapter via shared.ts. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type {
  CreateWorkInput,
  ListWorksOptions,
  UpdateWorkInput,
  WorkRepository,
} from "../../ports/work-repository.js";
import { WorkDeleteBlockedError, WorkNameConflictError } from "../../ports/work-repository.js";
import { DEFAULT_WORK_NAME } from "./shared.js";

export interface InMemoryWorkRepositoryOptions {
  hasLiveThreads?: (workId: WorkId) => boolean | Promise<boolean>;
  hasUnreviewedDrafts?: (workId: WorkId) => boolean | Promise<boolean>;
}

/** In-memory {@link WorkRepository} for tests. */
export function createInMemoryWorkRepository(
  options: InMemoryWorkRepositoryOptions = {},
): WorkRepository {
  const rows = new Map<string, Work>();

  function now(): string {
    return new Date().toISOString();
  }

  function build(input: CreateWorkInput): Work {
    const timestamp = now();
    return {
      id: input.id ?? crypto.randomUUID(),
      projectId: input.projectId,
      createdByUserId: input.createdByUserId ?? "00000000-0000-4000-8000-000000000000",
      name: input.name.trim(),
      goal: input.goal ?? null,
      description: input.description ?? null,
      status: "active",
      archivedAt: null,
      aiWriteMode: "direct",
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
  }

  function nameIsTaken(projectId: ProjectId, name: string, exceptId?: WorkId): boolean {
    const normalized = name.trim().toLocaleLowerCase();
    return [...rows.values()].some(
      (row) =>
        row.id !== exceptId &&
        row.projectId === projectId &&
        row.deletedAt === null &&
        row.name.toLocaleLowerCase() === normalized,
    );
  }

  const repo: WorkRepository = {
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      const snapshot = structuredClone(rows);
      try {
        return await operation();
      } catch (cause) {
        rows.clear();
        for (const [id, work] of snapshot) rows.set(id, work);
        throw cause;
      }
    },

    async create(input: CreateWorkInput): Promise<Work> {
      const work = build(input);
      if (nameIsTaken(work.projectId, work.name)) throw new WorkNameConflictError();
      rows.set(work.id, work);
      return { ...work };
    },

    async findById(id: WorkId): Promise<Work | null> {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },

    async listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]> {
      return [...rows.values()]
        .filter((w) => w.projectId === projectId && (opts?.includeDeleted || w.deletedAt === null))
        .filter((w) => !opts?.status || w.status === opts.status)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .map((w) => ({ ...w }));
    },

    async update(id: WorkId, input: UpdateWorkInput): Promise<Work> {
      const row = rows.get(id);
      if (!row || row.deletedAt) throw new Error(`Work not found: ${id}`);
      if (input.name !== undefined) {
        if (nameIsTaken(row.projectId, input.name, row.id)) throw new WorkNameConflictError();
        row.name = input.name.trim();
      }
      if (input.goal !== undefined) row.goal = input.goal;
      if (input.description !== undefined) row.description = input.description;
      row.updatedAt = now();
      row.lastActivityAt = row.updatedAt;
      return { ...row };
    },

    async archive(id: WorkId): Promise<Work> {
      const row = rows.get(id);
      if (!row || row.deletedAt) throw new Error(`Work not found: ${id}`);
      if (row.status === "active") {
        row.status = "archived";
        row.archivedAt = now();
        row.updatedAt = row.archivedAt;
        row.lastActivityAt = row.updatedAt;
      }
      return { ...row };
    },

    async unarchive(id: WorkId): Promise<Work> {
      const row = rows.get(id);
      if (!row || row.deletedAt) throw new Error(`Work not found: ${id}`);
      if (row.status === "archived") {
        row.status = "active";
        row.archivedAt = null;
        row.updatedAt = now();
        row.lastActivityAt = row.updatedAt;
      }
      return { ...row };
    },

    async hasUnreviewedDraft(id: WorkId): Promise<boolean> {
      return (await options.hasUnreviewedDrafts?.(id)) ?? false;
    },

    async softDelete(id: WorkId): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      if (await options.hasLiveThreads?.(id)) throw new WorkDeleteBlockedError("threads");
      if (await repo.hasUnreviewedDraft(id)) throw new WorkDeleteBlockedError("drafts");
      row.deletedAt = now();
      row.updatedAt = row.deletedAt;
      row.lastActivityAt = row.updatedAt;
    },

    async ensureDefaultForProject(projectId: ProjectId, name?: string): Promise<Work> {
      const existing = [...rows.values()].filter(
        (work) => work.projectId === projectId && work.deletedAt === null,
      );
      existing.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (existing[0]) return { ...existing[0] };
      const work = build({ projectId, name: name?.trim() || DEFAULT_WORK_NAME });
      rows.set(work.id, work);
      return { ...work };
    },

    async touch(id: WorkId): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      const timestamp = now();
      row.lastActivityAt = timestamp;
      row.updatedAt = timestamp;
    },
  };

  return repo;
}
