/** Drizzle arrival hooks: namespace-only locks plus the ahead registry's settlement. */
import type { Database } from "@meridian/database";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type { LinkAheadRegistry } from "../ports/link-ahead-registry.js";
import { lockDocumentNamespaces } from "./context-fs/document-locations.js";

export function createDrizzleDocumentArrivals(
  db: Database,
  registry: Pick<LinkAheadRegistry, "settleArrivals">,
): DocumentArrivals {
  return {
    lockNamespaces: (documentIds) => lockDocumentNamespaces(db, documentIds),
    settle: (documentIds) => registry.settleArrivals(documentIds),
  };
}
