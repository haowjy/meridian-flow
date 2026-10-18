/**
 * Item Apply as its route calls it: look the document's item up in the Work's active draft,
 * then apply that item under a fresh command. For suites that drive the collab facade
 * without the HTTP route core; answers the command's stored result.
 */
import type { DocumentId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { DraftReviewApi } from "../contracts.js";
import { testEnvelope } from "./draft-review-requests.js";

export async function applyDraftDocument(
  draftReview: Pick<DraftReviewApi, "resolveItemByDocument" | "applyItem">,
  input: { workId: WorkId; documentId: DocumentId; userId: UserId },
) {
  const found = await draftReview.resolveItemByDocument({
    workId: input.workId,
    documentId: input.documentId,
  });
  if (!found) throw new Error(`No draft item for ${input.documentId}`);
  const outcome = await draftReview.applyItem({
    workId: input.workId,
    item: found.item,
    userId: input.userId,
    envelope: testEnvelope({
      workId: input.workId,
      kind: "apply_items",
      branchId: found.branchId,
      userId: input.userId,
    }),
  });
  if (outcome.kind !== "result") throw new Error(`Apply answered ${outcome.kind}`);
  return outcome.result;
}
