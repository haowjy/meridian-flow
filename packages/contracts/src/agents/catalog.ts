/**
 * First-party package catalog contract: the promoted gallery served by
 * `GET /api/packages/catalog`. JSON-natural per the contracts package rule.
 */

/** One entry in the promoted first-party catalog (`GET /api/packages/catalog`). */
export interface FirstPartyCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** GitHub repo URL of the package; null while gallery-only. */
  sourceUrl: string | null;
}

/** Response for `GET /api/packages/catalog`. */
export interface FirstPartyCatalogResponse {
  packages: FirstPartyCatalogEntry[];
}
