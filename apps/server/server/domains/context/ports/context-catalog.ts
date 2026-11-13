/** Domain ports for durable catalog reads, mutation refresh, and lossy wake hints. */
import type {
  CatalogChanges,
  CatalogChannelMessage,
  CatalogChildrenRequest,
  CatalogChildrenResult,
  CatalogLookupRequest,
  CatalogLookupResult,
  CatalogScope,
  CatalogSnapshot,
  DraftOwnerHint,
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

/** Wakes the project's clients once the caller's transaction commits. Lossy, truth-free. */
export interface DraftOwnerHintPort {
  publishDraftOwnerHints(hints: readonly DraftOwnerHint[]): void;
}

export interface ContextCatalogWakePort {
  publish(hint: CatalogChannelMessage): void | Promise<void>;
}
