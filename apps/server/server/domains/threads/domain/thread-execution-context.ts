/** Thread execution policy: the chat's write mode over its locked primary Work. */
import type { AiWriteMode, ThreadExecutionContext, Work } from "@meridian/contracts/works";

/** Draft mode drafts into the Work the chat is bound to at the time of the call (D62). */
export function threadExecutionContext(
  work: Pick<Work, "id" | "slug">,
  aiWriteMode: AiWriteMode,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workSlug: work.slug },
    aiWriteMode,
    draftOwner: aiWriteMode === "draft" ? { kind: "work", workId: work.id } : null,
  };
}
