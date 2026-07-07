/** Shared key for serializing mutations against one live document. */
export function documentMutationLockKey(documentIdOrBranchId: string): string {
  return `document-mutation:${documentIdOrBranchId}`;
}
