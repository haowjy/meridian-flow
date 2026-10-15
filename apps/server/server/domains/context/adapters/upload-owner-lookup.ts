/** Which chat received an upload, by its address, for holders that spell no chat. */
import type { Database } from "@meridian/database";
import { contextSources, uploadIntakes } from "@meridian/database/schema";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { UploadOwnerLookup } from "../ports/document-link-resolver.js";

export function createDrizzleUploadOwnerLookup(db: Database): UploadOwnerLookup {
  return {
    async chatOf(projectId, path) {
      // Two chats may each hold a `seal.png`; the first one received wins, so the answer
      // never moves when a later chat attaches the same name.
      const [row] = await currentDrizzleDb(db)
        .select({ chatId: uploadIntakes.ownerThreadId })
        .from(uploadIntakes)
        .innerJoin(contextSources, eq(contextSources.id, uploadIntakes.contextSourceId))
        .where(
          and(
            eq(uploadIntakes.projectId, projectId),
            ne(uploadIntakes.state, "deleted"),
            sql`${uploadIntakes.ownerThreadId} IS NOT NULL`,
            sql`lower(${uploadIntakes.finalPath}) = lower(${path})`,
            isNull(contextSources.deletedAt),
          ),
        )
        .orderBy(asc(uploadIntakes.createdAt), asc(uploadIntakes.documentId))
        .limit(1);
      return row?.chatId ?? null;
    },
  };
}
