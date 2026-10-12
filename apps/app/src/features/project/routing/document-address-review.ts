/** A plain address never acquires a review's authority to read a hidden document. */
import type { DocumentAddressRequestOptions } from "@meridian/contracts/protocol";

export function documentAddressReview(
  draftId: string | undefined,
  workId: string | null,
): DocumentAddressRequestOptions["review"] {
  return draftId && workId ? { workId, draftBranchId: draftId } : undefined;
}
