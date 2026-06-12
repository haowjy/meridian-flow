// @ts-nocheck
/**
 * Work persistence port: the CRUD contract for "works" (units of work within a
 * workbench) plus its input/option types. The boundary both the drizzle and
 * in-memory work adapters implement.
 */
import type { WorkbenchId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";

export interface CreateWorkInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: WorkId;
  workbenchId: WorkbenchId;
  title?: string;
  description?: string | null;
}

export interface ListWorksOptions {
  /** Include soft-deleted works. Defaults to false. */
  includeDeleted?: boolean;
}

/**
 * Work-item CRUD for the workbenches domain. Backed by the `schema` `works`
 * table; rows map to the JSON-natural {@link Work} contract.
 *
 * A work item groups one or more primary threads under a workbench and owns the
 * shared knowledge built during grilling.
 */
export interface WorkRepository {
  create(input: CreateWorkInput): Promise<Work>;
  findById(id: WorkId): Promise<Work | null>;
  listByWorkbench(workbenchId: WorkbenchId, opts?: ListWorksOptions): Promise<Work[]>;
  /**
   * Return the workbench's most-recent active work, creating a default one if
   * none exists. Used to attach new primary threads to a real work item until
   * the orchestrator owns work creation during grilling.
   */
  ensureDefaultForWorkbench(workbenchId: WorkbenchId, title?: string): Promise<Work>;
  touch(id: WorkId): Promise<void>;
}
