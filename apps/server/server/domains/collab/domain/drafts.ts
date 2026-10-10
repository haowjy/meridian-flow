/**
 * The one drafts resolver: which draft a Work's drafted writes share, and the view a
 * read in that Work sees. A draft is made only at the write boundary, never by a read
 * (F7): a draft-mode Work with no active draft reads live.
 */
import type { DraftId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { Draft, DraftStore, DraftWriteBoundary } from "./ports/draft-store.js";

export interface Drafts {
  /** Reads: the Work's active draft as a view, else live. Never creates a draft. */
  viewForWork(workId: WorkId | null): Promise<TreeView>;
  /**
   * The write boundary only: locks the Work row (refusing an archived or deleted Work),
   * then the Work's active draft, made if absent, row-locked. Joins the caller's command
   * transaction when there is one, else runs in its own. The only path that makes a draft.
   */
  ensureActiveForWrite(input: {
    workId: WorkId;
    projectId: ProjectId;
    threadId: ThreadId | null;
    userId: UserId;
  }): Promise<Draft>;
}

export class DraftClosedUnderWorkLockError extends Error {
  constructor(readonly draftId: DraftId) {
    super(`Draft ${draftId} closed while its Work was locked`);
    this.name = "DraftClosedUnderWorkLockError";
  }
}

export function createDrafts(deps: { store: DraftStore; boundary: DraftWriteBoundary }): Drafts {
  return {
    async viewForWork(workId) {
      if (workId === null) return { kind: "live" };
      const draft = await deps.store.activeForWork(workId);
      return draft ? { kind: "draft", draftId: draft.id } : { kind: "live" };
    },
    ensureActiveForWrite(input) {
      return deps.boundary.withActiveWorkLocked(input.workId, async () => {
        const ensured = await deps.store.ensureActiveLocked({
          workId: input.workId,
          projectId: input.projectId,
          originThreadId: input.threadId,
          createdBy: input.userId,
        });
        // Every close locks the Work first, so the draft can't close between these.
        const locked = await deps.store.lockActive(ensured.id);
        if (!locked) throw new DraftClosedUnderWorkLockError(ensured.id);
        return locked;
      });
    },
  };
}
