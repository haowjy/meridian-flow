export const accountQueryKeys = {
  all: ["account"] as const,
  recentDocumentsRoot: (accountId: string) => ["account", accountId, "recent-documents"] as const,
  recentDocuments: (accountId: string, projectId: string) =>
    [...accountQueryKeys.recentDocumentsRoot(accountId), projectId] as const,
};
