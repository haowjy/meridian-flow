/** The browser database a list's copy is stored in, named by its account: sign-out finds an account's lists by the prefix. */
export const treeListCopyPrefix = (accountId: string) => `meridian:tree-list:v1:${accountId}:`;
