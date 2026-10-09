/** Drizzle arrival hooks: namespace-only locks plus the ahead registry's settlement. */
import type { Database } from "@meridian/database";
import {
  isInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideWrite,
} from "../../../shared/drizzle-transaction.js";
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
    async settleCommitted(documentIds) {
      if (isInDrizzleTransaction()) {
        throw new Error("Committed arrivals settle in their own root transaction");
      }
      if (documentIds.length === 0) return 0;
      return runOutsideWrite(() =>
        runInRootDrizzleTransaction(db, async () => {
          await lockDocumentNamespaces(db, documentIds);
          return registry.settleArrivals(documentIds);
        }),
      );
    },
  };
}
