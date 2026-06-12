// @ts-nocheck
/**
 * Workbench persistence port: the CRUD contract (create/update/list/get/soft-delete)
 * for workbenches plus its input/option types. The boundary both the drizzle and
 * in-memory workbench adapters implement.
 */

import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import type { Workbench } from "@meridian/contracts/workbenches";

export interface CreateWorkbenchInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: WorkbenchId;
  userId: UserId;
  title?: string;
  description?: string | null;
}

export interface UpdateWorkbenchInput {
  title?: string;
  description?: string | null;
}

export interface ListWorkbenchesOptions {
  /** Include soft-deleted workbenches. Defaults to false. */
  includeDeleted?: boolean;
}

/**
 * Workbench CRUD backed by the `schema` `workbenches` table; rows map to the JSON-natural {@link Workbench} contract (`created_by → userId`).
 */
export interface WorkbenchRepository {
  create(input: CreateWorkbenchInput): Promise<Workbench>;
  findById(id: WorkbenchId): Promise<Workbench | null>;
  listByUser(userId: UserId, opts?: ListWorkbenchesOptions): Promise<Workbench[]>;
  search(userId: UserId, query: string): Promise<Workbench[]>;
  update(id: WorkbenchId, input: UpdateWorkbenchInput): Promise<Workbench>;
  softDelete(id: WorkbenchId): Promise<Workbench>;
  restore(id: WorkbenchId): Promise<Workbench>;
  touch(id: WorkbenchId): Promise<void>;
}
