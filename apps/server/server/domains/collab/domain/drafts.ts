/**
 * The one drafts resolver: which draft a Work's drafted writes share, the view a read in
 * that Work sees, and the lock and lifecycle calls every later lane makes on drafts. A
 * draft is made only at the write boundary, never by a read (F7): a draft-mode chat's Work with
 * no active draft reads live. Callers reach drafts only through this object.
 */
import type { DraftId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { Draft, DraftStore, DraftWriteBoundary } from "./ports/draft-store.js";

export interface Drafts {
  /** Reads: the Work's active draft as a view, else live. Never creates a draft. */
  viewForWork(workId: WorkId | null): Promise<TreeView>;
  /**
   * The write boundary only, and the only path that makes a draft: locks the Work row
   * (refusing an archived or deleted Work), then the Work's active draft, made if absent,
   * row-locked. With no ambient transaction it runs in its own. Inside one it joins only
   * a transaction the ContextFS command boundary approved (`approveDraftWriteJoin`: it has
   * locked nothing but Works); any other ambient caller gets `DraftWriteJoinRefusedError`,
   * so it never takes the Work lock after namespace or document locks.
   */
  ensureActiveForWrite(input: {
    workId: WorkId;
    projectId: ProjectId;
    threadId: ThreadId | null;
    userId: UserId;
  }): Promise<Draft>;
  /** No lock. The oldest active draft whose origin is this Work, else null. */
  activeForWork(workId: WorkId): Promise<Draft | null>;
  /**
   * Caller's transaction, after its Work row locks: `FOR NO KEY UPDATE` on the draft;
   * null when closed or missing. Apply, Discard and closing take this.
   */
  lockActive(draftId: DraftId): Promise<Draft | null>;
  /**
   * Caller's transaction, before any namespace lock: `FOR SHARE`, for a writer that needs
   * the draft to stay active without changing it (ahead registration, peer ensure); null
   * when closed or missing.
   */
  shareActive(draftId: DraftId): Promise<Draft | null>;
  /**
   * Caller's transaction, the draft locked by `lockActive` and every one of its branches
   * leased: closes the draft and its branches and deletes its settlements.
   */
  close(draftId: DraftId, at: Date): Promise<void>;
  /** No lock. These drafts, any status. */
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  /** Purge only: every draft whose origin is this Work, any status, oldest first. */
  byOriginWork(workId: WorkId): Promise<Draft[]>;
}

export class DraftClosedUnderWorkLockError extends Error {
  constructor(readonly draftId: DraftId) {
    super(`Draft ${draftId} closed while its Work was locked`);
    this.name = "DraftClosedUnderWorkLockError";
  }
}

export function createDrafts(deps: { store: DraftStore; boundary: DraftWriteBoundary }): Drafts {
  const { store } = deps;
  return {
    async viewForWork(workId) {
      if (workId === null) return { kind: "live" };
      const draft = await store.activeForWork(workId);
      return draft ? { kind: "draft", draftId: draft.id } : { kind: "live" };
    },
    ensureActiveForWrite(input) {
      return deps.boundary.withActiveWorkLocked(input.workId, async () => {
        const ensured = await store.ensureActiveLocked({
          workId: input.workId,
          projectId: input.projectId,
          originThreadId: input.threadId,
          createdBy: input.userId,
        });
        // Every close locks the Work first, so the draft can't close between these.
        const locked = await store.lockActive(ensured.id);
        if (!locked) throw new DraftClosedUnderWorkLockError(ensured.id);
        return locked;
      });
    },
    activeForWork: (workId) => store.activeForWork(workId),
    lockActive: (draftId) => store.lockActive(draftId),
    shareActive: (draftId) => store.shareActive(draftId),
    close: (draftId, at) => store.close(draftId, at),
    byIds: (draftIds) => store.byIds(draftIds),
    byOriginWork: (workId) => store.byOriginWork(workId),
  };
}
