/**
 * Canonical React Query key factory for account-scoped reads.
 */
export const accountQueryKeys = {
  all: ["account"] as const,
  recentDocuments: (limit?: number) => ["account", "recent-documents", limit ?? null] as const,
};
