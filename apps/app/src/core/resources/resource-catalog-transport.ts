/** Existing project catalog HTTP APIs behind the account-bound resource port. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { ResourceCatalogTransport } from "@meridian/resource-replica";
import { getContextCatalogChanges, getContextCatalogSnapshot } from "@/client/api/projects-api";

export function createResourceCatalogTransport(accountId: string): ResourceCatalogTransport {
  return {
    accountId,
    snapshot: (projectId: string, scope: CatalogScope) =>
      getContextCatalogSnapshot(projectId, scope),
    changes: (projectId: string, scope: CatalogScope, cursor: string) =>
      getContextCatalogChanges(projectId, scope, cursor),
  };
}
