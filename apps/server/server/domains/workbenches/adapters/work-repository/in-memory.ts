// @ts-nocheck
/** In-memory WorkRepository for tests: Map-backed work CRUD implementing the port. Shares the default-title constant with the drizzle adapter via shared.ts. */
import type { WorkbenchId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type {
  CreateWorkInput,
  ListWorksOptions,
  WorkRepository,
} from "../../ports/work-repository.js";
import { DEFAULT_WORK_TITLE } from "./shared.js";

/** In-memory {@link WorkRepository} for tests. */
export function createInMemoryWorkRepository(): WorkRepository {
  const rows = new Map<string, Work>();
  const defaultIdsByWorkbench = new Map<string, string>();

  function now(): string {
    return new Date().toISOString();
  }

  function build(input: CreateWorkInput): Work {
    const timestamp = now();
    return {
      id: input.id ?? crypto.randomUUID(),
      workbenchId: input.workbenchId,
      title: input.title?.trim() || DEFAULT_WORK_TITLE,
      description: input.description ?? null,
      status: "active",
      visibility: "private",
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

    async listByWorkbench(workbenchId: WorkbenchId, opts?: ListWorksOptions): Promise<Work[]> {
      return [...rows.values()]
        .filter(
          (w) => w.workbenchId === workbenchId && (opts?.includeDeleted || w.deletedAt === null),
        )
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .map((w) => ({ ...w }));
    },

    async ensureDefaultForWorkbench(workbenchId: WorkbenchId, title?: string): Promise<Work> {
      const defaultId = defaultIdsByWorkbench.get(workbenchId);
      const existing = defaultId ? rows.get(defaultId) : undefined;
      if (existing) return { ...existing };
      const work = build({ workbenchId, title });
      rows.set(work.id, work);
      defaultIdsByWorkbench.set(workbenchId, work.id);
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
