/** Thread execution policy from a locked Work. */
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";

export function threadExecutionContext(
  work: Pick<Work, "id" | "slug" | "aiWriteMode">,
): ThreadExecutionContext {
  return {
    scope: { workId: work.id, workSlug: work.slug },
    aiWriteMode: work.aiWriteMode,
    draftOwner: work.aiWriteMode === "draft" ? { kind: "work", workId: work.id } : null,
  };
}
