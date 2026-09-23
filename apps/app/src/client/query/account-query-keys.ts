/**
 * Canonical React Query key factory for account-scoped reads.
 */
export const accountQueryKeys = {
  all: ["account"] as const,
  /** One account's recents lists. An old account's fetch cannot land in another's cache. */
  recentDocumentsRoot: (accountId: string) => ["account", accountId, "recent-documents"] as const,
  /**
   * One project's recents. The project belongs in the key because the landing
   * renders inside a project: without it, moving to another project would show
   * the rows of the one you left.
   */
  recentDocuments: (accountId: string, projectId: string) =>
    [...accountQueryKeys.recentDocumentsRoot(accountId), projectId] as const,
};
