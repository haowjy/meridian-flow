/** In-memory WorkRepository for tests; Work child cascades are DB-only and are not modeled here. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { decideWorkRestore } from "../../domain/work-restore.js";
import type {
  CreateWorkInput,
  ListWorksOptions,
  UpdateWorkInput,
  WorkRepository,
  WorkRestoration,
} from "../../ports/work-repository.js";
import {
  WorkLockedError,
  WorkNameConflictError,
  WorkRestoreConflictError,
} from "../../ports/work-repository.js";
import { NO_WORK_NAME, nextWorkSlug } from "./shared.js";

/** In-memory {@link WorkRepository} for tests. */
export function createInMemoryWorkRepository(options: { now?: () => Date } = {}): WorkRepository {
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

  const currentTime = options.now ?? (() => new Date());

  function now(): string {
    return currentTime().toISOString();
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
          .filter((work) => work.projectId === input.projectId)
          .map((work) => work.slug),
      ),
      isNoWork: false,
      goal: input.goal ?? null,
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
      if (input.id && rows.has(input.id)) throw new Error(`Work already exists: ${input.id}`);
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

    async findNoWork(projectId: ProjectId): Promise<Work | null> {
      const row = [...rows.values()].find(
        (work) => work.projectId === projectId && work.isNoWork && work.deletedAt === null,
      );
      return row ? { ...row } : null;
    },

    async ensureNoWork(projectId: ProjectId): Promise<Work> {
      const existing = await repo.findNoWork(projectId);
      if (existing) return existing;
      const timestamp = now();
      for (const row of rows.values()) {
        if (
          row.projectId === projectId &&
          !row.isNoWork &&
          row.deletedAt === null &&
          row.name.trim().toLocaleLowerCase() === NO_WORK_NAME.toLocaleLowerCase()
        ) {
          row.name = `${NO_WORK_NAME} (named)`;
          row.updatedAt = timestamp;
          row.lastActivityAt = timestamp;
          advance(row);
        }
      }
      const work: Work = {
        id: crypto.randomUUID(),
        projectId,
        createdByUserId: "00000000-0000-4000-8000-000000000000",
        name: NO_WORK_NAME,
        slug: null,
        isNoWork: true,
        goal: null,
        status: "active",
        archivedAt: null,
        aiWriteMode: "direct",
        entityRevision: "1",
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      rows.set(work.id, work);
      projectState(projectId).revision += 1n;
      return { ...work };
    },

    async listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]> {
      return [...rows.values()]
        .filter((w) => w.projectId === projectId && (opts?.includeDeleted || w.deletedAt === null))
        .filter((w) => !opts?.status || w.status === opts.status)
        .filter((w) => opts?.includeNoWork || !w.isNoWork)
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
      if (row.isNoWork) throw new WorkLockedError();
      if (input.name !== undefined) {
        if (nameIsTaken(row.projectId, input.name, row.id)) throw new WorkNameConflictError();
        row.name = input.name.trim();
      }
      if (input.goal !== undefined) row.goal = input.goal;
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
      if (row.isNoWork) throw new WorkLockedError();
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
      if (row.isNoWork) throw new WorkLockedError();
      if (row.status === "archived") {
        row.status = "active";
        row.archivedAt = null;
        row.updatedAt = now();
        row.lastActivityAt = row.updatedAt;
        advance(row);
      }
      return { ...row };
    },

    async softDelete(id: WorkId) {
      return repo.transaction(async () => {
        const row = rows.get(id);
        if (!row || row.deletedAt) {
          return {
            before: row ? { ...row } : null,
            after: row ? { ...row } : null,
            threadIds: [],
          };
        }
        if (row.isNoWork) throw new WorkLockedError();
        const before = { ...row };
        const deletedAt = currentTime();
        row.deletedAt = deletedAt.toISOString();
        row.updatedAt = row.deletedAt;
        row.lastActivityAt = row.updatedAt;
        advance(row);
        return { before, after: { ...row }, threadIds: [] };
      });
    },

    async restore(id: WorkId): Promise<WorkRestoration> {
      return repo.transaction(async () => {
        const row = rows.get(id);
        if (!row) throw new Error(`Work not found: ${id}`);
        if (decideWorkRestore(row, currentTime()) === "unchanged") {
          const existing = { ...row };
          return { before: existing, after: existing, changed: false };
        }
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
        const before = { ...row };
        const restoredAt = currentTime();
        row.deletedAt = null;
        row.updatedAt = restoredAt.toISOString();
        row.lastActivityAt = row.updatedAt;
        advance(row);
        return { before, after: { ...row }, changed: true };
      });
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
