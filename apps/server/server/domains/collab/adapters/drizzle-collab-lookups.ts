/** Drizzle-backed lookup functions used by collab service composition. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents, turns } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleCollabLookups(db: Database) {
  return {
    /** Reads on the open transaction, if any: a document created in it has its row only there. */
    async resolveDocumentFiletype(documentId: string): Promise<string | null> {
      const [row] = await currentDrizzleDb(db)
        .select({ filetype: documents.fileType })
        .from(documents)
        .where(eq(documents.id, documentId as never))
        .limit(1);
      return row?.filetype ?? null;
    },
    async resolveTurnThreadId(turnId: TurnId): Promise<ThreadId | null> {
      const [row] = await db
        .select({ threadId: turns.threadId })
        .from(turns)
        .where(eq(turns.id, turnId))
        .limit(1);
      return row?.threadId ?? null;
    },
  };
}
