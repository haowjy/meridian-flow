import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";

export function draftCopyView(
  file: ReviewFileTarget,
  draftId: string,
): CopyContextEntryView | null {
  return file.item.pending && !file.draftOnly ? { kind: "draft", draft: draftId } : null;
}
