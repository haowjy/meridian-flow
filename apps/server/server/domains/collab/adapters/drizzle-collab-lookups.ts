import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { threads } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";

import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentPlacement } from "../../context/tree/tree-addresses.js";

export function createDrizzleCollabLookups(db: Database) {
  return {
    async resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
      if (!threadIds.length) return new Map();
      const rows = await currentDrizzleDb(db)
        .select({ id: threads.id, title: threads.title })
        .from(threads)
        .where(inArray(threads.id, threadIds as ThreadId[]));
      return new Map(rows.map((row) => [row.id, row.title]));
    },
    async resolveDocumentFiletype(documentId: string): Promise<string | null> {
      return (
        (await loadDocumentPlacement(currentDrizzleDb(db), documentId as DocumentId))?.fileType ??
        null
      );
    },
  };
}
