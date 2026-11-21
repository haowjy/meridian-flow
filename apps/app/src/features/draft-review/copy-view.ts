/**
 * What a Copy of a document under review reads: the server finds the text by draft and document,
 * so no chat is named and none can be the wrong one.
 */
import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";

/**
 * The draft of `draftId` for this change, or null when it has no text to copy: a document the
 * draft created is no placed entry yet, and a tree-only change has no draft text.
 */
export function draftCopyView(
  file: ReviewFileTarget,
  draftId: string,
): CopyContextEntryView | null {
  return file.draft.hasDraft && !file.draftOnly ? { kind: "draft", draft: draftId } : null;
}
