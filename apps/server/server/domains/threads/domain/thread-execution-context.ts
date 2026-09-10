/** Nullable thread execution policy and the Work-branch-only guard. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { AiWriteMode, ThreadExecutionContext, Work } from "@meridian/contracts/works";

export class WorkRequiredError extends Error {
  readonly code = "work_required" as const;
  constructor(readonly operation: string) {
    super(`Work required for ${operation}`);
    this.name = "WorkRequiredError";
  }
}

export function threadExecutionContext(
  work: Pick<Work, "id" | "slug" | "aiWriteMode"> | null,
): ThreadExecutionContext {
  if (!work) return { scope: { kind: "none" }, aiWriteMode: "direct", draftOwner: null };
  return {
    scope: { kind: "work", workId: work.id, workSlug: work.slug },
    aiWriteMode: work.aiWriteMode,
    draftOwner: work.aiWriteMode === "draft" ? { kind: "work", workId: work.id } : null,
  };
}

export function requireWorkDraftOwner(
  context: ThreadExecutionContext,
  operation: string,
): { kind: "work"; workId: WorkId } {
  if (!context.draftOwner) throw new WorkRequiredError(operation);
  return context.draftOwner;
}

export function directWriteMode(context: ThreadExecutionContext): AiWriteMode {
  return context.scope.kind === "none" ? "direct" : context.aiWriteMode;
}
