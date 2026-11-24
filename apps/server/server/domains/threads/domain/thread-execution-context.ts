import type { Thread } from "@meridian/contracts/threads";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";

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
