/**
 * Work persistence port: the CRUD contract for "works" (units of work within a
 * project) plus its input/option types. The boundary both the drizzle and
 * in-memory work adapters implement.
 */
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";

export interface CreateWorkInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: WorkId;
  projectId: ProjectId;
  createdByUserId?: import("@meridian/contracts/runtime").UserId;
  name: string;
  goal?: string;
}

export interface UpdateWorkInput {
  name?: string;
  goal?: string | null;
  /** AI-owned one-to-three-word progress summary. */
  status?: string | null;
}

export interface ListWorksOptions {
  /** Include soft-deleted works. Defaults to false. */
  includeDeleted?: boolean;
  /** Filter by archive lifecycle. Omit to include both. */
  archived?: boolean;
  /** Include the locked No Work row. Defaults to false. */
  includeNoWork?: boolean;
}

export class WorkNameConflictError extends Error {
  constructor() {
    super("A Work with this name already exists in the project");
    this.name = "WorkNameConflictError";
  }
}

export class WorkRestoreConflictError extends Error {
  constructor(public readonly reason: "name" | "slug") {
    super(
      reason === "name"
        ? "Work cannot be restored because its name is now in use"
        : "Work cannot be restored because its slug is now in use",
    );
    this.name = "WorkRestoreConflictError";
  }
}

export class WorkLockedError extends Error {
  readonly code = "work_locked" as const;
  constructor() {
    super("No Work cannot be renamed, archived, or deleted");
    this.name = "WorkLockedError";
  }
}

export class WorkRestoreExpiredError extends Error {
  readonly code = "work_restore_expired" as const;

  constructor() {
    super("This Work can no longer be restored because its 30-day retention period has ended.");
    this.name = "WorkRestoreExpiredError";
  }
}

/** Internal transaction retry when a thread joined the Work after the lock set was read. */
export class WorkDeleteRetryError extends Error {
  constructor() {
    super("Work membership changed during deletion");
    this.name = "WorkDeleteRetryError";
  }
}

export type WorkDeletion = {
  before: Work | null;
  after: Work | null;
  /** Threads hidden by this deletion, returned for the runtime's cancel path. */
  threadIds: ThreadId[];
};

export type WorkRestoration = {
  before: Work;
  after: Work;
  changed: boolean;
};

/**
 * Work-item CRUD for the projects domain. Backed by the `schema` `works`
 * table; rows map to the JSON-natural {@link Work} contract.
 *
 * A work item groups one or more primary threads under a project and owns the
 * shared knowledge built during grilling.
 */
export interface WorkRepository {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  readSnapshot<T>(operation: () => Promise<T>): Promise<T>;
  /** Locks the Work lifecycle row for the ambient transaction, then returns it. */
  lockById(id: WorkId): Promise<Work | null>;
  create(input: CreateWorkInput): Promise<Work>;
  findById(id: WorkId): Promise<Work | null>;
  findNoWork(projectId: ProjectId): Promise<Work | null>;
  ensureNoWork(projectId: ProjectId): Promise<Work>;
  /** Lists most recently updated first. Named Works only unless includeNoWork. */
  listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]>;
  snapshotIdentity(projectId: ProjectId): Promise<{
    catalogGeneration: string;
    authorityRevision: string;
  }>;
  update(id: WorkId, input: UpdateWorkInput): Promise<Work>;
  archive(id: WorkId, archivedAt?: string): Promise<Work>;
  unarchive(id: WorkId): Promise<Work>;
  /** Soft-deletes the Work and marks its live children in the same transaction. */
  softDelete(id: WorkId): Promise<WorkDeletion>;
  /** Restores a soft-deleted Work and exactly its marked children, with an exact receipt. */
  restore(id: WorkId): Promise<WorkRestoration>;
  touch(id: WorkId): Promise<void>;
}
