/** Only teardown of the review still named by the address may consume its request. */
export function exitedReviewOwnsAddress(
  owned: { workId: string; documentId: string; draftId: string },
  address: { workId: string; documentId?: string | null; draftId?: string },
): boolean {
  return (
    !!address.draftId &&
    owned.workId === address.workId &&
    owned.documentId === address.documentId &&
    owned.draftId === address.draftId
  );
}
