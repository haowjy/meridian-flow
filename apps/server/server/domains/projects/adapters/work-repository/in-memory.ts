/** In-memory WorkRepository for tests: Map-backed work CRUD implementing the port. Shares the default-title constant with the drizzle adapter via shared.ts. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
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
import { nextWorkSlug } from "./shared.js";

export interface InMemoryWorkRepositoryOptions {
  hasLiveThreads?: (workId: WorkId) => boolean | Promise<boolean>;
  hasUnreviewedDrafts?: (workId: WorkId) => boolean | Promise<boolean>;
  hasDocuments?: (workId: WorkId) => boolean | Promise<boolean>;
  hasFolders?: (workId: WorkId) => boolean | Promise<boolean>;
}

/** In-memory {@link WorkRepository} for tests. */
export function createInMemoryWorkRepository(
  options: InMemoryWorkRepositoryOptions = {},
): WorkRepository {
  const rows = new Map<string, Work>();
  const projects = new Map<string, { catalogGeneration: string; revision: bigint }>();

  function projectState(projectId: string) {
    let state = projects.get(projectId);
    if (!state) {
      state = { catalogGeneration: crypto.randomUUID(), revision: 0n };
      projects.set(projectId, state);
    }
    return state;
  }

  function advance(work: Work): void {
    work.entityRevision = String(BigInt(work.entityRevision) + 1n);
    projectState(work.projectId).revision += 1n;
  }

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
      slug: nextWorkSlug(
        input.name,
        [...rows.values()]
          .filter((work) => work.projectId === input.projectId && work.deletedAt === null)
          .map((work) => work.slug),
      ),
      goal: input.goal ?? null,
      description: input.description ?? null,
      status: "active",
      archivedAt: null,
      aiWriteMode: "direct",
      entityRevision: "1",
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
      const projectSnapshot = structuredClone(projects);
      try {
        return await operation();
      } catch (cause) {
        rows.clear();
        for (const [id, work] of snapshot) rows.set(id, work);
        projects.clear();
        for (const [id, state] of projectSnapshot) projects.set(id, state);
        throw cause;
      }
    },

    async readSnapshot<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },

    async lockById(id: WorkId): Promise<Work | null> {
      return repo.findById(id);
    },

    async create(input: CreateWorkInput): Promise<Work> {
      const work = build(input);
      if (nameIsTaken(work.projectId, work.name)) throw new WorkNameConflictError();
      rows.set(work.id, work);
      projectState(work.projectId).revision += 1n;
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

    async snapshotIdentity(projectId: ProjectId) {
      const state = projectState(projectId);
      return {
        catalogGeneration: state.catalogGeneration,
        authorityRevision: String(state.revision),
      };
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
      const timestamp = now();
      if (input.status !== undefined) {
        row.status = input.status;
        row.archivedAt = input.status === "archived" ? timestamp : null;
      }
      row.updatedAt = timestamp;
      row.lastActivityAt = timestamp;
      advance(row);
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
        advance(row);
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
        advance(row);
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
      if (await options.hasDocuments?.(id)) throw new WorkDeleteBlockedError("documents");
      if (await options.hasFolders?.(id)) throw new WorkDeleteBlockedError("folders");
      row.deletedAt = now();
      row.updatedAt = row.deletedAt;
      row.lastActivityAt = row.updatedAt;
      advance(row);
    },

    async restore(id: WorkId): Promise<Work> {
      const row = rows.get(id);
      if (!row) throw new Error(`Work not found: ${id}`);
      if (!row.deletedAt) return { ...row };
      if (nameIsTaken(row.projectId, row.name, row.id)) {
        throw new WorkRestoreConflictError("name");
      }
      const slugIsTaken = [...rows.values()].some(
        (other) =>
          other.id !== row.id &&
          other.projectId === row.projectId &&
          other.deletedAt === null &&
          other.slug === row.slug,
      );
      if (slugIsTaken) throw new WorkRestoreConflictError("slug");
      row.deletedAt = null;
      row.updatedAt = now();
      row.lastActivityAt = row.updatedAt;
      advance(row);
      return { ...row };
    },

    async touch(id: WorkId): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      const timestamp = now();
      row.lastActivityAt = timestamp;
      row.updatedAt = timestamp;
      advance(row);
    },
  };

  return repo;
}
