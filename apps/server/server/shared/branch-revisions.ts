/**
 * The one door for a branch metadata write outside a content write: a close, a hold flag, a
 * journal row's status flip. The rows are locked in id order and their `revision` bumped with
 * the change, so a write judged at the old revision cannot commit over it. Content writes go
 * through `appendRowsWithinTx` and `commitRewriteWithinTx` instead.
 */
import { documentBranches } from "@meridian/database/schema";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DrizzleDb } from "./drizzle-transaction.js";

export type BranchRevisionChange = {
  /** Sets the hold flag; a branch already holding this value is left alone. */
  blocking?: boolean;
  /** Closes the branch; one already closed is left alone. */
  status?: "closed";
  /** The branch must still be active at exactly this revision, or nothing is written. */
  expectedRevision?: number;
};

/**
 * `branchIds` locked in id order and bumped with `change`; returns the branches it wrote. A
 * branch the change would not alter, or one that moved past `expectedRevision`, is skipped.
 */
export async function bumpBranchRevisions(
  db: Pick<DrizzleDb, "select" | "update">,
  branchIds: readonly string[],
  change: BranchRevisionChange = {},
) {
  const ids = [...new Set(branchIds)].sort();
  if (!ids.length) return [];
  const { expectedRevision, ...set } = change;
  const predicates: (SQL | undefined)[] = [inArray(documentBranches.id, ids)];
  if (set.blocking !== undefined)
    predicates.push(sql`${documentBranches.blocking} IS DISTINCT FROM ${set.blocking}`);
  if (set.status !== undefined || expectedRevision !== undefined)
    predicates.push(eq(documentBranches.status, "active"));
  if (expectedRevision !== undefined)
    predicates.push(eq(documentBranches.revision, expectedRevision));
  const locked = await db
    .select({ id: documentBranches.id })
    .from(documentBranches)
    .where(and(...predicates))
    .orderBy(asc(documentBranches.id))
    .for("update");
  if (!locked.length) return [];
  return db
    .update(documentBranches)
    .set({
      ...set,
      ...(set.status ? { updatedAt: new Date() } : {}),
      revision: sql`${documentBranches.revision} + 1`,
    })
    .where(
      inArray(
        documentBranches.id,
        locked.map((row) => row.id),
      ),
    )
    .returning({
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      threadId: documentBranches.threadId,
      kind: documentBranches.kind,
      generation: documentBranches.generation,
      revision: documentBranches.revision,
    });
}
