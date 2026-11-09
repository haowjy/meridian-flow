/** Thread execution policy: the chat's write mode over its locked primary Work. */
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";
import { chatOwner } from "../../../shared/draft-owner.js";

/**
 * Draft mode writes drafts into the branch of the chat's owner at the time of the call:
 * the Work it is bound to, or its conversation lineage when that Work is No Work.
 */
export function threadExecutionContext(
  work: Pick<Work, "id" | "handle" | "isNoWork">,
  thread: Pick<Thread, "projectId" | "rootThreadId" | "aiWriteMode">,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workHandle: work.handle },
    aiWriteMode: thread.aiWriteMode,
    branchOwner: thread.aiWriteMode === "draft" ? chatOwner(thread, work) : null,
  };
}
