/** One removal kernel for delete, overwrite, Work cascade and the last hidden-node use. */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches, branchTreeChanges, documents } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentRemoval, DocumentRemovalCollab } from "../ports/document-removal.js";
import { bumpLocationVersions } from "./node-locations.js";
import { releaseDocumentStorage } from "./node-rows.js";

export function createDocumentRemoval(
  db: Database,
  collab: DocumentRemovalCollab,
): DocumentRemoval {
  return {
    async remove(input) {
      const ids = [...new Set(input.documentIds)].sort();
      const tx = currentDrizzleDb(db);
      const living = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(inArray(documents.id, ids), isNull(documents.deletedAt)));
      const removed = living.map((row) => row.id as DocumentId);
      if (!removed.length) {
        return collab.closeRemovedDocuments({
          documentIds: [],
          workIds: input.affectedWorkIds ?? [],
        });
      }
      const uses = await tx
        .select({ workId: branches.originWorkId })
        .from(branchTreeChanges)
        .innerJoin(branches, eq(branches.id, branchTreeChanges.branchId))
        .where(
          and(
            eq(branchTreeChanges.nodeKind, "document"),
            inArray(branchTreeChanges.nodeId, removed),
          ),
        );
      await tx
        .update(documents)
        .set({
          deletedAt: input.at ?? new Date(),
          updatedAt: input.at ?? new Date(),
          deletionReason: input.reason,
          deletedByUserId: input.userId ?? null,
          deletedByWorkId: input.workId ?? null,
          deletionCause: input.cause ?? null,
        })
        .where(inArray(documents.id, removed));
      await bumpLocationVersions(db, { documentIds: removed });
      await tx
        .delete(branchTreeChanges)
        .where(
          and(
            eq(branchTreeChanges.nodeKind, "document"),
            inArray(branchTreeChanges.nodeId, removed),
          ),
        );
      const closed = await collab.closeRemovedDocuments({
        documentIds: removed,
        workIds: [
          ...new Set([
            ...(input.affectedWorkIds ?? []),
            ...uses.flatMap((row) => (row.workId ? [row.workId] : [])),
          ]),
        ],
      });
      if (input.reason === "discarded") await releaseDocumentStorage(db, removed);
      return closed;
    },
  };
}
