/**
 * Canonical React Query key factory for account-scoped reads.
 */
const RECENT_DOCUMENTS_ROOT = ["account", "recent-documents"] as const;

export const accountQueryKeys = {
  all: ["account"] as const,
  /** Every recents list: the invalidation target after a record. */
  recentDocumentsRoot: RECENT_DOCUMENTS_ROOT,
  /**
   * One project's recents. The project belongs in the key because the landing
   * renders inside a project: without it, moving to another project would show
   * the rows of the one you left.
   */
  recentDocuments: (projectId: string) => [...RECENT_DOCUMENTS_ROOT, projectId] as const,
};
