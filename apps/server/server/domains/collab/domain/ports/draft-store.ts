/** Persistence port for Work drafts: the `drafts` rows the resolver owns. */
import type { DraftId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";

export type DraftStatus = "active" | "closed";

export type Draft = {
  id: DraftId;
  projectId: ProjectId;
  status: DraftStatus;
  /** Provenance, not ownership (decision 3). */
  originWorkId: WorkId | null;
  originThreadId: ThreadId | null;
  createdBy: UserId;
  createdAt: Date;
};

export interface DraftStore {
  /** No lock. Oldest active draft whose origin is this Work, else null. */
  activeForWork(workId: WorkId): Promise<Draft | null>;
  /** Caller's transaction, Work row already locked: the active draft, inserted if absent. */
  ensureActiveLocked(input: {
    workId: WorkId;
    projectId: ProjectId;
    originThreadId: ThreadId | null;
    createdBy: UserId;
  }): Promise<Draft>;
  /** Caller's transaction, after Work locks: `FOR NO KEY UPDATE`; null when closed or missing. */
  lockActive(draftId: DraftId): Promise<Draft | null>;
  /** `FOR SHARE`: a writer that needs the draft to stay active without changing it. */
  shareActive(draftId: DraftId): Promise<Draft | null>;
  /**
   * Caller's transaction, draft locked: the row closes and its settlements go. Closing
   * its branches joins this when branches key by draft (lane K).
   */
  close(draftId: DraftId, at: Date): Promise<void>;
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  /** Purge only: every draft whose origin is this Work, any status. */
  byOriginWork(workId: WorkId): Promise<Draft[]>;
}

/** The write boundary's transaction and Work row lock. */
export interface DraftWriteBoundary {
  /**
   * Opens its own transaction, or joins an ambient one only when the command boundary
   * approved it (it has locked nothing but Works); refuses any other ambient caller. Locks
   * the Work row and refuses a Work that isn't active with `WorkLifecycleUnavailableError`.
   */
  withActiveWorkLocked<T>(workId: WorkId, operation: () => Promise<T>): Promise<T>;
}
