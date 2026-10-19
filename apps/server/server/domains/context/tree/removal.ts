/**
 * The removal record's one owner: the kernel that writes it (delete, overwrite, Work cascade,
 * the last use of a hidden creation), the Work Restore that clears it, and its reader.
 */
import type { DocumentId, WorkId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { branchTreeChanges, documents, users, works } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { DocumentRemoval, DocumentRemovalCollab } from "../ports/document-removal.js";
import { bumpLocationVersions } from "./node-locations.js";
import { releaseDocumentStorage } from "./node-rows.js";
import { loadActiveBranchUses, loadDocumentIdentityRows } from "./tree-view-sql.js";

/** Works whose branches use these documents, in the caller's transaction. */
async function usingWorks(tx: DrizzleDb, ids: readonly DocumentId[]): Promise<WorkId[]> {
  const uses = await loadActiveBranchUses(tx, ids);
  return uses.flatMap(({ originWorkId }) => (originWorkId ? [originWorkId] : []));
}

export function createDocumentRemoval(
  db: Database,
  deps: {
    collab: DocumentRemovalCollab;
    /** Works the removal changed but the caller does not hold are recounted after commit. */
    workProjection: Pick<WorkProjectionMutation, "recountAfterCommit">;
  },
): DocumentRemoval {
  return {
    async remove(input) {
      const ids = [...new Set(input.documentIds)].sort();
      const tx = currentDrizzleDb(db);
      const living = (await loadDocumentIdentityRows(tx, ids)).filter((row) => !row.deleted);
      const removed = living.map((row) => row.id as DocumentId);
      if (!removed.length) return [];
      const affected = await usingWorks(tx, removed);
      const now = input.at ?? new Date();
      await tx
        .update(documents)
        .set({
          deletedAt: now,
          updatedAt: now,
          deletionReason: input.reason,
          deletedByUserId: input.userId ?? null,
          deletedByWorkId: input.workId ?? null,
          deletionCause: input.cause ?? null,
        })
        .where(inArray(documents.id, removed));
      await bumpLocationVersions(db, { documentIds: removed });
      // A Work cascade keeps hidden creations' tree uses: `restoreWorkDocuments` brings their
      // membership back with the tombstone, while a revealed document needs none.
      const retired = input.workId
        ? living.filter((row) => !row.hidden).map((row) => row.id)
        : removed;
      if (retired.length)
        await tx
          .delete(branchTreeChanges)
          .where(
            and(
              eq(branchTreeChanges.nodeKind, "document"),
              inArray(branchTreeChanges.nodeId, retired),
            ),
          );
      const [record] = (await readRemovalRecords(tx, removed.slice(0, 1))).values();
      if (!record) throw new Error(`Removal of ${removed[0]} wrote no record`);
      const drafted = await deps.collab.closeRemovedDocuments(removed, record);
      deps.workProjection.recountAfterCommit([...affected, ...drafted]);
      if (input.reason === "discarded") await releaseDocumentStorage(db, removed);
      return removed;
    },
  };
}

/**
 * A Work Restore's documents: every one its deletion removed stands again, at the location
 * it held, and returns the Works whose branches use them, whose pending counts moved.
 */
export async function restoreWorkDocuments(db: Database, workId: WorkId): Promise<WorkId[]> {
  const tx = currentDrizzleDb(db);
  const restored = await tx
    .update(documents)
    .set({
      deletedAt: null,
      deletionReason: null,
      deletedByUserId: null,
      deletionCause: null,
      deletedByWorkId: null,
      locationVersion: sql`${documents.locationVersion} + 1`,
    })
    .where(eq(documents.deletedByWorkId, workId))
    .returning({ id: documents.id });
  return usingWorks(
    tx,
    restored.map(({ id }) => id as DocumentId),
  );
}

/**
 * The current removal record of each removed document among `documentIds`, with actor names
 * as they read now, through the handle given (the caller's transaction when it has one).
 * `documents_removal_presence` guarantees a tombstone has its reason.
 */
export async function readRemovalRecords(
  db: Pick<DrizzleDb, "select">,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>> {
  const records = new Map<DocumentId, DocumentRemovalRecord>();
  if (!documentIds.length) return records;
  const rows = await db
    .select({
      id: documents.id,
      reason: documents.deletionReason,
      time: documents.deletedAt,
      userId: documents.deletedByUserId,
      displayName: users.name,
      workName: works.name,
      cause: documents.deletionCause,
    })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.deletedByUserId))
    .leftJoin(works, eq(works.id, documents.deletedByWorkId))
    .where(and(inArray(documents.id, [...documentIds]), isNotNull(documents.deletedAt)));
  for (const row of rows) {
    records.set(row.id as DocumentId, {
      reason: row.reason as DocumentRemovalRecord["reason"],
      time: (row.time as Date).toISOString(),
      actor:
        row.workName !== null
          ? { kind: "work", name: row.workName }
          : row.userId
            ? { kind: "user", userId: row.userId, displayName: row.displayName }
            : row.cause
              ? { kind: "system", cause: row.cause }
              : null,
    });
  }
  return records;
}
