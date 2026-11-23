/** Thread execution policy: the chat's write mode over its locked primary Work. */
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";

/**
 * A chat's drafts, in draft mode or where a place asks for review, go into the chat's draft
 * (`Thread.draftId`: its root's, while that is one of its Work's, else the Work's default). Every
 * chat has one; its write mode says whether all its writes draft.
 */
export function threadExecutionContext(
  work: Pick<Work, "id" | "handle">,
  thread: Pick<Thread, "draftId" | "aiWriteMode">,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workHandle: work.handle },
    aiWriteMode: thread.aiWriteMode,
    draftId: thread.draftId as ThreadExecutionContext["draftId"],
  };
}
