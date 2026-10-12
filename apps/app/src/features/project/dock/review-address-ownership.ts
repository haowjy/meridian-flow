/** Only teardown of the review still named by the address may consume its request. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

type ReviewLocator = { scheme: ProjectContextTreeScheme; path: string };
export type OwnedReviewAddress = {
  workId: string;
  documentId: string;
  draftId: string;
  /** Last locator confirmed by identity or the review's location, not a pending rename guess. */
  locator: ReviewLocator | null;
};

export function exitedReviewOwnsAddress(
  owned: OwnedReviewAddress,
  address: {
    workId: string;
    documentId?: string | null;
    draftId?: string;
    locator: ReviewLocator | null;
  },
): boolean {
  if (!address.draftId || owned.workId !== address.workId || owned.draftId !== address.draftId)
    return false;
  if (address.documentId) return owned.documentId === address.documentId;
  return (
    !!owned.locator &&
    !!address.locator &&
    owned.locator.scheme === address.locator.scheme &&
    owned.locator.path === address.locator.path
  );
}
