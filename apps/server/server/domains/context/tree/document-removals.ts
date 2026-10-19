/** Batched removal records with current actor names, in the caller's transaction. */
import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, users, works } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentRemovals } from "../ports/document-removals.js";

export function createDrizzleDocumentRemovals(db: Database): DocumentRemovals {
  return {
    async lookup(documentIds) {
      const records = new Map<DocumentId, DocumentRemovalRecord>();
      if (!documentIds.length) return records;
      const rows = await currentDrizzleDb(db)
        .select({
          id: documents.id,
          reason: documents.deletionReason,
          time: documents.deletedAt,
          userId: documents.deletedByUserId,
          displayName: users.name,
          workId: documents.deletedByWorkId,
          workName: works.name,
          cause: documents.deletionCause,
        })
        .from(documents)
        .leftJoin(users, eq(users.id, documents.deletedByUserId))
        .leftJoin(works, eq(works.id, documents.deletedByWorkId))
        .where(and(inArray(documents.id, [...documentIds]), isNotNull(documents.deletedAt)));
      for (const row of rows) {
        if (!row.reason || !row.time) throw new Error(`Incomplete removal record for ${row.id}`);
        records.set(row.id, {
          reason: row.reason,
          time: row.time.toISOString(),
          actor:
            row.workId && row.workName !== null
              ? { kind: "work", workId: row.workId, name: row.workName }
              : row.userId
                ? { kind: "user", userId: row.userId, displayName: row.displayName }
                : row.cause
                  ? { kind: "system", cause: row.cause }
                  : null,
        });
      }
      return records;
    },
  };
}
