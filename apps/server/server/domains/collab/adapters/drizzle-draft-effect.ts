/** Canonical draft effect relative to its last pulled live cut, plus hold visibility. */
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { materializeBranchRead } from "../domain/branch-coordinator.js";
import { documentEffectsEqual } from "../domain/document-content.js";
import { readBranchAt } from "./drizzle-branches.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/**
 * Recomputes `has_effect` from the branch's checkpoint and tail against its live cut. A flip
 * is a review-membership change, so it bumps `revision`; the branch's revision after the
 * refresh comes back (none for a branch that is not a work draft).
 */
export async function refreshDraftEffect(
  db: DrizzleDb,
  branchId: string,
  liveCut?: Uint8Array,
  resetBaseline = false,
): Promise<{ revision: number } | undefined> {
  const [cut] = await db
    .select({ liveCut: documentBranches.liveCut })
    .from(documentBranches)
    .where(eq(documentBranches.id, branchId));
  const read = cut ? await readBranchAt(db, branchId) : null;
  if (read?.branch.kind !== "work_draft") return undefined;
  const live = new Y.Doc({ gc: false });
  let draft: Y.Doc | undefined;
  try {
    let baseline = liveCut ?? (resetBaseline ? undefined : cut?.liveCut);
    if (!baseline) {
      const snapshot = await createDrizzleJournal(db as Database).read(read.branch.documentId);
      if (snapshot.checkpoint) Y.applyUpdate(live, snapshot.checkpoint);
      for (const row of snapshot.updates) Y.applyUpdate(live, row.update);
      baseline = Y.encodeStateAsUpdate(live);
    } else Y.applyUpdate(live, baseline);
    draft = materializeBranchRead(read);
    const hasEffect = !documentEffectsEqual(live, draft);
    const [row] = await db
      .update(documentBranches)
      .set({
        hasEffect,
        liveCut: Buffer.from(baseline),
        revision: sql`${documentBranches.revision} + case when ${documentBranches.hasEffect} is distinct from ${hasEffect} then 1 else 0 end`,
      })
      .where(eq(documentBranches.id, branchId))
      .returning({ revision: documentBranches.revision });
    return row ? { revision: Number(row.revision) } : undefined;
  } finally {
    live.destroy();
    draft?.destroy();
  }
}
