/**
 * The one door for a draft metadata write outside a content write: a close, a hold flag, a
 * journal row's status flip. The rows are locked in id order and their `revision` bumped with
 * the change, so a write judged at the old revision cannot commit over it. Content writes go
 * through `appendRowsWithinTx` and `commitRewriteWithinTx` instead.
 */
import { documentDrafts } from "@meridian/database/schema";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DrizzleDb } from "./drizzle-transaction.js";

type DraftRevisionChange = (
  | { status: "closed"; closedCause: "discarded" | "document_removed" }
  | { status?: never; closedCause?: never }
) & {
  /** Sets the hold flag; a draft already holding this value is left alone. */
  blocking?: boolean;
  /** The draft must still be active at exactly this revision, or nothing is written. */
  expectedRevision?: number;
};

/**
 * `draftIds` locked in id order and bumped with `change`; returns the drafts it wrote. A
 * draft the change would not alter, or one that moved past `expectedRevision`, is skipped.
 */
export async function bumpDraftRevisions(
  db: Pick<DrizzleDb, "select" | "update">,
  draftIds: readonly string[],
  change: DraftRevisionChange = {},
) {
  const ids = [...new Set(draftIds)].sort();
  if (!ids.length) return [];
  const { expectedRevision, ...set } = change;
  const predicates: (SQL | undefined)[] = [inArray(documentDrafts.id, ids)];
  if (set.blocking !== undefined)
    predicates.push(sql`${documentDrafts.blocking} IS DISTINCT FROM ${set.blocking}`);
  if (set.status !== undefined || expectedRevision !== undefined)
    predicates.push(eq(documentDrafts.status, "active"));
  if (expectedRevision !== undefined)
    predicates.push(eq(documentDrafts.revision, expectedRevision));
  const locked = await db
    .select({ id: documentDrafts.id })
    .from(documentDrafts)
    .where(and(...predicates))
    .orderBy(asc(documentDrafts.id))
    .for("update");
  if (!locked.length) return [];
  return db
    .update(documentDrafts)
    .set({
      ...set,
      ...(set.status ? { updatedAt: new Date() } : {}),
      revision: sql`${documentDrafts.revision} + 1`,
    })
    .where(
      inArray(
        documentDrafts.id,
        locked.map((row) => row.id),
      ),
    )
    .returning({
      draftId: documentDrafts.id,
      documentId: documentDrafts.documentId,
      branchId: documentDrafts.branchId,
      threadId: documentDrafts.threadId,
      kind: documentDrafts.kind,
      generation: documentDrafts.generation,
      revision: documentDrafts.revision,
    });
}
