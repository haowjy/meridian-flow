/** Drizzle-backed lookup functions used by collab service composition. */
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents, turns, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { WriteMode } from "../contracts.js";

export function createDrizzleCollabLookups(db: Database) {
  return {
    async resolveDocumentFiletype(documentId: string): Promise<string | null> {
      const [row] = await db
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
    async resolveWorkWriteMode(workId: WorkId): Promise<WriteMode | null> {
      const [row] = await db
        .select({ aiWriteMode: works.aiWriteMode })
        .from(works)
        .where(eq(works.id, workId))
        .limit(1);
      return row?.aiWriteMode === "draft"
        ? "draft"
        : row?.aiWriteMode === "direct"
          ? "direct"
          : null;
    },
  };
}
