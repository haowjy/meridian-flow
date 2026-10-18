/** A work draft's effect recomputed against live, for a re-fork that moves its baseline. */
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { materializeBranchRead } from "../domain/branch-store.js";
import { documentEffectsEqual } from "../domain/document-content.js";
import { readBranchAt } from "./drizzle-branch-storage.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/**
 * Recomputes `has_effect` from the branch's checkpoint and tail against the document's live
 * state, which becomes its live cut (a selective Discard's re-fork). A flip is a
 * review-membership change, so it bumps `revision`; the branch's revision after the refresh
 * comes back (none for a branch that is not a work draft).
 */
export async function refreshDraftEffect(
  db: DrizzleDb,
  branchId: string,
): Promise<{ revision: number } | undefined> {
  const read = await readBranchAt(db, branchId);
  if (read?.branch.kind !== "work_draft") return undefined;
  const live = new Y.Doc({ gc: false });
  let draft: Y.Doc | undefined;
  try {
    const snapshot = await createDrizzleJournal(db as Database).read(read.branch.documentId);
    if (snapshot.checkpoint) Y.applyUpdate(live, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(live, row.update);
    const baseline = Y.encodeStateAsUpdate(live);
    draft = materializeBranchRead(read);
    const hasEffect = !documentEffectsEqual(live, draft);
    const flip = sql`case when ${documentBranches.hasEffect} is distinct from ${hasEffect} then 1 else 0 end`;
    const [row] = await db
      .update(documentBranches)
      .set({
        hasEffect,
        liveCut: Buffer.from(baseline),
        revision: sql`${documentBranches.revision} + ${flip}`,
        // The judgement holds at the revision this write leaves (design §3.2's watermark).
        hasEffectRevision: sql`${documentBranches.revision} + ${flip}`,
      })
      .where(eq(documentBranches.id, branchId))
      .returning({ revision: documentBranches.revision });
    return row ? { revision: Number(row.revision) } : undefined;
  } finally {
    live.destroy();
    draft?.destroy();
  }
}
