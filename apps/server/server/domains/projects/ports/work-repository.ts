import type { DraftId } from "@meridian/contracts";
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { AiWriteMode, Work } from "@meridian/contracts/works";

export interface CreateWorkInput {
  id?: WorkId;
  draftId?: DraftId;
  projectId: ProjectId;
  createdByUserId?: import("@meridian/contracts/runtime").UserId;
  name: string;
  goal?: string | null;
}

export interface UpdateWorkInput {
  name?: string;
  goal?: string | null;
  status?: string | null;
}

export interface ListWorksOptions {
  includeDeleted?: boolean;
  lifecycle?: "active" | "archived" | "all";
  includeNoWork?: boolean;
}

export class WorkLockedError extends Error {
  readonly code = "work_locked" as const;
  constructor() {
    super("No Work cannot be renamed, archived, or deleted");
    this.name = "WorkLockedError";
  }
}

export class WorkDeleteRetryError extends Error {
  constructor() {
    super("Work membership changed during deletion");
    this.name = "WorkDeleteRetryError";
  }
}

export type WorkDeletion = {
  before: Work | null;
  after: Work | null;
};

export type WorkRestoration = {
  before: Work;
  after: Work;
  changed: boolean;
};

export interface WorkRepository {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  readSnapshot<T>(operation: () => Promise<T>): Promise<T>;
  lockById(id: WorkId): Promise<Work | null>;
  create(input: CreateWorkInput): Promise<Work>;
  findById(id: WorkId): Promise<Work | null>;
  findByHandle(projectId: ProjectId, handle: string): Promise<Work | null>;
  findNoWork(projectId: ProjectId): Promise<Work | null>;
  ensureNoWork(projectId: ProjectId): Promise<Work>;
  listByProject(projectId: ProjectId, opts?: ListWorksOptions): Promise<Work[]>;
  snapshotIdentity(projectId: ProjectId): Promise<{
    authorityRevision: string;
  }>;
  update(id: WorkId, input: UpdateWorkInput): Promise<Work>;
  archive(id: WorkId): Promise<Work>;
  unarchive(id: WorkId): Promise<Work>;
  softDelete(
    id: WorkId,
    endThreads?: (threadIds: readonly ThreadId[]) => Promise<void>,
  ): Promise<WorkDeletion>;
  restore(id: WorkId): Promise<WorkRestoration>;
  lockRestoreNamespaces(ids: readonly WorkId[]): Promise<void>;
  touch(id: WorkId): Promise<void>;
  setDefaultAiWriteMode(id: WorkId, mode: AiWriteMode): Promise<void>;
}
