/** Thread execution policy: the chat's write mode over its locked primary Work. */
import type { Thread } from "@meridian/contracts/threads";
import { draftOf, type ThreadExecutionContext, type Work } from "@meridian/contracts/works";

/**
 * A chat's drafts, in draft mode or where a place asks for review, go into the draft its owner
 * names at the time of the call: the Work it is bound to, or its conversation lineage when that
 * Work is No Work. Every chat has one; its write mode says whether all its writes draft.
 */
export function threadExecutionContext(
  work: Pick<Work, "id" | "handle" | "isNoWork" | "draftId">,
  thread: Pick<Thread, "draftId" | "aiWriteMode">,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workHandle: work.handle },
    aiWriteMode: thread.aiWriteMode,
    draftId: draftOf(thread, work),
  };
}
