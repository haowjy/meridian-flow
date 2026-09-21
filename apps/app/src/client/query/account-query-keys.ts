/**
 * Canonical React Query key factory for account-scoped reads.
 */
const RECENT_DOCUMENTS_ROOT = ["account", "recent-documents"] as const;

export const accountQueryKeys = {
  all: ["account"] as const,
  /** Prefix key: invalidating this refreshes every limit variant. */
  recentDocumentsRoot: RECENT_DOCUMENTS_ROOT,
  recentDocuments: (limit?: number) => [...RECENT_DOCUMENTS_ROOT, limit ?? null] as const,
};
