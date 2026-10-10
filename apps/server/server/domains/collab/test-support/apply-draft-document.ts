/**
 * The legacy per-document Apply as its route calls it: look the document's item up in the
 * Work's active draft, then apply that item. For suites that drive the collab facade
 * without the HTTP route core.
 */
import type { DocumentId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { DraftReviewApi } from "../contracts.js";

export async function applyDraftDocument(
  draftReview: Pick<DraftReviewApi, "item" | "applyWorkDraft">,
  input: { workId: WorkId; documentId: DocumentId; userId: UserId },
) {
  const found = await draftReview.item({ workId: input.workId, documentId: input.documentId });
  if (!found) throw new Error(`No draft item for ${input.documentId}`);
  return draftReview.applyWorkDraft({
    workId: input.workId,
    item: found.item,
    userId: input.userId,
  });
}
