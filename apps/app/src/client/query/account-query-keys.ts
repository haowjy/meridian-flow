/**
 * Canonical React Query key factory for account-scoped reads.
 */
export const accountQueryKeys = {
  all: ["account"] as const,
  /** One key: the landing's read and the invalidation target for a record. */
  recentDocuments: ["account", "recent-documents"] as const,
};
