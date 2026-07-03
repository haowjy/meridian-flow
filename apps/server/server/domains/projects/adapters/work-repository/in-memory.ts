/** In-memory WorkRepository for tests: Map-backed work CRUD implementing the port. Shares the default-title constant with the drizzle adapter via shared.ts. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import type {
  CreateWorkInput,
  ListWorksOptions,
  WorkRepository,
} from "../../ports/work-repository.js";
import { DEFAULT_WORK_TITLE } from "./shared.js";

/** In-memory {@link WorkRepository} for tests. */
export function createInMemoryWorkRepository(): WorkRepository {
  const rows = new Map<string, Work>();
  const defaultIdsByProject = new Map<string, string>();

  function now(): string {
    return new Date().toISOString();
  }

  function build(input: CreateWorkInput): Work {
    const timestamp = now();
    return {
      id: input.id ?? crypto.randomUUID(),
      projectId: input.projectId,
      createdByUserId: input.createdByUserId ?? "00000000-0000-4000-8000-000000000000",
      title: input.title?.trim() || DEFAULT_WORK_TITLE,
      visibility: "private",
      aiWriteMode: "direct",
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
  }

  const repo: WorkRepository = {
    async create(input: CreateWorkInput): Promise<Work> {
      const work = build(input);
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
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .map((w) => ({ ...w }));
    },

    async ensureDefaultForProject(projectId: ProjectId, title?: string): Promise<Work> {
      const defaultId = defaultIdsByProject.get(projectId);
      const existing = defaultId ? rows.get(defaultId) : undefined;
      if (existing) return { ...existing };
      const work = build({ projectId, title });
      rows.set(work.id, work);
      defaultIdsByProject.set(projectId, work.id);
      return { ...work };
    },

    async updateWriteMode(id: WorkId, aiWriteMode: AiWriteMode): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      const timestamp = now();
      row.aiWriteMode = aiWriteMode;
      row.lastActivityAt = timestamp;
      row.updatedAt = timestamp;
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
