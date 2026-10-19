/** Draft closure and settlement, always locking upstream Work drafts before thread peers. */
import type { DocumentId, ThreadId } from "@meridian/contracts";
import { documentDrafts } from "@meridian/database/schema";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { bumpDraftRevisions } from "../../../shared/draft-revisions.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { PeerRetirementCause, RetiredDraft } from "../domain/peer-retirement.js";
import { settleDraftGeneration } from "./drizzle-document-edits.js";

/** The caller holds its Work/branch and document admission locks; pulls lock upstream first too. */
export async function lockActiveDrafts(db: DrizzleDb, predicate: SQL | undefined) {
  if (!predicate) throw new Error("Draft closure requires an explicit selection");
  const rows = [];
  for (const kind of ["work_draft", "thread_peer"] as const) {
    rows.push(
      ...(await db
        .select({
          id: documentDrafts.id,
          generation: documentDrafts.generation,
          threadId: documentDrafts.threadId,
        })
        .from(documentDrafts)
        .where(and(predicate, eq(documentDrafts.status, "active"), eq(documentDrafts.kind, kind)))
        .orderBy(asc(documentDrafts.id))
        .for("update")),
    );
  }
  return rows;
}

/** Close exactly these drafts and settle only their current generations. Already-closed rows keep their cause. */
export async function closeDrafts(
  db: DrizzleDb,
  predicate: SQL | undefined,
  closedCause: "discarded" | "document_removed",
  cause: PeerRetirementCause,
): Promise<RetiredDraft[]> {
  const rows = await lockActiveDrafts(db, predicate);
  const closed = await bumpDraftRevisions(
    db,
    rows.map((row) => row.id),
    { status: "closed", closedCause },
  );
  for (const row of closed) {
    if (row.kind === "work_draft")
      await settleDraftGeneration(db, row.draftId, row.generation, "discarded");
  }
  return closed.map((row) =>
    row.threadId
      ? {
          draftId: row.draftId,
          documentId: row.documentId as DocumentId,
          threadId: row.threadId as ThreadId,
          cause,
        }
      : { draftId: row.draftId, documentId: row.documentId as DocumentId, threadId: null },
  );
}
