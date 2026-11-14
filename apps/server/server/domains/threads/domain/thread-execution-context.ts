/** Thread execution policy: the chat's write mode over its locked primary Work. */
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";
import { chatOwner } from "../../../shared/draft-owner.js";

/**
 * A chat's drafts, in draft mode or where a place asks for review, go into the branch of its owner
 * at the time of the call: the Work it is bound to, or its conversation lineage when that Work is
 * No Work. Every chat has the owner; its write mode says whether all its writes draft.
 */
export function threadExecutionContext(
  work: Pick<Work, "id" | "handle" | "isNoWork">,
  thread: Pick<Thread, "projectId" | "rootThreadId" | "aiWriteMode">,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workHandle: work.handle },
    aiWriteMode: thread.aiWriteMode,
    branchOwner: chatOwner(thread, work),
  };
}
