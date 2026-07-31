/**
 * Work persistence port: the CRUD contract for "works" (units of work within a
 * project) plus its input/option types. The boundary both the drizzle and
 * in-memory work adapters implement.
 */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";

export interface CreateWorkInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: WorkId;
  projectId: ProjectId;
  createdByUserId?: import("@meridian/contracts/runtime").UserId;
  name: string;
  goal?: string;
  description?: string;
}

export interface UpdateWorkInput {
  name?: string;
  goal?: string;
  description?: string;
}

export interface ListWorksOptions {
  /** Include soft-deleted works. Defaults to false. */
  includeDeleted?: boolean;
  status?: WorkStatus;
}

export class WorkDeleteBlockedError extends Error {
  constructor(public readonly reason: "threads" | "drafts") {
    super(
      reason === "threads"
        ? "Work cannot be deleted while it has conversations"
        : "Work cannot be deleted while it has an unreviewed draft",
    );
    this.name = "WorkDeleteBlockedError";
  }
}

/**
 * Work-item CRUD for the projects domain. Backed by the `schema` `works`
 * table; rows map to the JSON-natural {@link Work} contract.
 *
 * A work item groups one or more primary threads under a project and owns the
 * shared knowledge built during grilling.
 */
export interface WorkRepository {
  create(input: CreateWorkInput): Promise<Work>;
  findById(id: WorkId): Promise<Work | null>;
  /** Lists most recently updated first. */
  listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]>;
  update(id: WorkId, input: UpdateWorkInput): Promise<Work>;
  archive(id: WorkId): Promise<Work>;
  unarchive(id: WorkId): Promise<Work>;
  /** Soft-deletes only when no live thread membership or unreviewed Work draft remains. */
  softDelete(id: WorkId): Promise<void>;
  /**
   * Provision the project's sole active Work when none exists. Refuses multiple
   * active Works; selection policy belongs to resolveDefaultWork.
   */
  ensureDefaultForProject(projectId: ProjectId, name?: string): Promise<Work>;
  touch(id: WorkId): Promise<void>;
}
