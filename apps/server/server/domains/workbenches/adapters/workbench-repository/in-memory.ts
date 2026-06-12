// @ts-nocheck
/** In-memory WorkbenchRepository for tests: Map-backed workbench CRUD implementing the port. Shares default-title/slug behavior with the drizzle adapter via shared.ts. */

import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import type { Workbench } from "@meridian/contracts/workbenches";
import type {
  CreateWorkbenchInput,
  ListWorkbenchesOptions,
  UpdateWorkbenchInput,
  WorkbenchRepository,
} from "../../ports/workbench-repository.js";
import { DEFAULT_WORKBENCH_TITLE } from "./shared.js";

/** In-memory {@link WorkbenchRepository} for tests. */
export function createInMemoryWorkbenchRepository(): WorkbenchRepository {
  const rows = new Map<string, Workbench>();

  function now(): string {
    return new Date().toISOString();
  }

  return {
    async create(input: CreateWorkbenchInput): Promise<Workbench> {
      const timestamp = now();
      const workbench: Workbench = {
        id: input.id ?? crypto.randomUUID(),
        userId: input.userId,
        title: input.title?.trim() || DEFAULT_WORKBENCH_TITLE,
        description: input.description ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      rows.set(workbench.id, workbench);
      return { ...workbench };
    },

    async findById(id: WorkbenchId): Promise<Workbench | null> {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },

    async listByUser(userId: UserId, opts?: ListWorkbenchesOptions): Promise<Workbench[]> {
      return [...rows.values()]
        .filter((p) => p.userId === userId && (opts?.includeDeleted || p.deletedAt === null))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => ({ ...p }));
    },

    async search(userId: UserId, query: string): Promise<Workbench[]> {
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

    async update(id: WorkbenchId, input: UpdateWorkbenchInput): Promise<Workbench> {
      const row = rows.get(id);
      if (!row) throw new Error(`Workbench not found: ${id}`);
      if (input.title !== undefined) row.title = input.title;
      if (input.description !== undefined) row.description = input.description;
      row.updatedAt = now();
      return { ...row };
    },

    async softDelete(id: WorkbenchId): Promise<Workbench> {
      const row = rows.get(id);
      if (!row) throw new Error(`Workbench not found: ${id}`);
      if (row.deletedAt === null) row.deletedAt = now();
      return { ...row };
    },

    async restore(id: WorkbenchId): Promise<Workbench> {
      const row = rows.get(id);
      if (!row) throw new Error(`Workbench not found: ${id}`);
      row.deletedAt = null;
      return { ...row };
    },

    async touch(id: WorkbenchId): Promise<void> {
      const row = rows.get(id);
      if (!row || row.deletedAt) return;
      row.updatedAt = now();
    },
  };
}
