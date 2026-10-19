/** Removal's collab capability: durable close now, room/runtime retirement and recount after commit. */
import type { WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches, documentDrafts } from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentRemovalCollab } from "../../context/ports/document-removal.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { PeerRetirement } from "../domain/peer-retirement.js";
import { closeDrafts } from "./drizzle-draft-close.js";

export function createDrizzleDocumentRemovalCollab(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    closeRooms(documentIds: readonly string[], draftIds: readonly string[]): Promise<void>;
    retire: PeerRetirement;
    onError(error: unknown): void;
  },
): DocumentRemovalCollab {
  function recount(workIds: readonly WorkId[]) {
    if (!workIds.length) return;
    runAfterDrizzleCommit(async () => {
      try {
        await runInRootDrizzleTransaction(db, () =>
          deps.workProjection.mutate({ works: workIds }, async () => undefined),
        );
      } catch (error) {
        deps.onError(error);
        throw error;
      }
    });
  }
  return {
    recount,
    async closeRemovedDocuments({ documentIds, workIds }) {
      const tx = currentDrizzleDb(db);
      const owners = await tx
        .select({
          workId: branches.originWorkId,
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          threadId: documentDrafts.threadId,
        })
        .from(documentDrafts)
        .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
        .where(inArray(documentDrafts.documentId, [...documentIds]));
      const affected = [
        ...new Set([...workIds, ...owners.flatMap((row) => (row.workId ? [row.workId] : []))]),
      ].sort();
      const closed = await closeDrafts(
        tx,
        inArray(documentDrafts.documentId, [...documentIds]),
        "document_removed",
        "document_discarded",
      );
      runAfterDrizzleCommit(async () => {
        try {
          await Promise.all([
            deps.closeRooms(
              documentIds,
              owners.map((row) => row.draftId),
            ),
            deps.retire(
              owners.map((row) =>
                row.threadId
                  ? {
                      draftId: row.draftId,
                      documentId: row.documentId,
                      threadId: row.threadId,
                      cause: "document_discarded" as const,
                    }
                  : { draftId: row.draftId, documentId: row.documentId, threadId: null },
              ),
            ),
          ]);
        } catch (error) {
          deps.onError(error);
          throw error;
        }
      });
      recount(affected);
      await testHook("removal.afterClose");
      return closed;
    },
  };
}
