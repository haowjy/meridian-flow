/** Domain ports for durable catalog reads, mutation refresh, and lossy wake hints. */
import type {
  CatalogChanges,
  CatalogChildrenRequest,
  CatalogChildrenResult,
  CatalogLookupRequest,
  CatalogLookupResult,
  CatalogScope,
  CatalogSnapshot,
  CatalogWakeHint,
} from "@meridian/contracts/protocol";

export const DEFAULT_CATALOG_CHANGES_LIMIT = 100;
export const MAX_CATALOG_CHANGES_LIMIT = 500;

/** Keep every domain caller bounded even when it bypasses the HTTP grammar. */
export function normalizeCatalogChangesLimit(limit = DEFAULT_CATALOG_CHANGES_LIMIT): number {
  const finiteLimit = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_CATALOG_CHANGES_LIMIT;
  return Math.max(1, Math.min(MAX_CATALOG_CHANGES_LIMIT, finiteLimit));
}

export interface ContextCatalog {
  snapshot(scope: CatalogScope): Promise<CatalogSnapshot>;
  changes(scope: CatalogScope, cursor: string, limit?: number): Promise<CatalogChanges>;
  children(input: CatalogChildrenRequest): Promise<CatalogChildrenResult>;
  lookup(input: CatalogLookupRequest): Promise<CatalogLookupResult>;
}

export interface ContextCatalogMutationPort {
  /** Reconcile authoritative rows for each affected source in the ambient transaction. */
  refreshSources(
    sourceIds: readonly string[],
    invalidatedRootIds?: readonly string[],
  ): Promise<string>;
  /** Reconcile project authority entries after a Work/project lifecycle mutation. */
  refreshProject(projectId: string): Promise<void>;
}

export interface WorkAuthorityCatalogMutationPort {
  /** Upsert only the named Work authority signals in their project scopes. */
  upsertWorkAuthorities(workIds: readonly string[]): Promise<void>;
}

export interface ContextCatalogWakePort {
  publish(hint: CatalogWakeHint): void | Promise<void>;
}
