/** Canonical draft effect relative to its last pulled live cut, plus hold visibility. */
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { documentEffectsEqual } from "../domain/document-content.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

export async function refreshDraftEffect(
  db: DrizzleDb,
  branchId: string,
  liveCut?: Uint8Array,
  resetBaseline = false,
): Promise<void> {
  const [branch] = await db
    .select()
    .from(documentBranches)
    .where(eq(documentBranches.id, branchId));
  if (branch?.kind !== "work_draft") return;
  const live = new Y.Doc({ gc: false }),
    draft = new Y.Doc({ gc: false });
  try {
    let baseline = liveCut ?? (resetBaseline ? undefined : branch.liveCut);
    if (!baseline) {
      const snapshot = await createDrizzleJournal(db as Database).read(branch.documentId);
      if (snapshot.checkpoint) Y.applyUpdate(live, snapshot.checkpoint);
      for (const row of snapshot.updates) Y.applyUpdate(live, row.update);
      baseline = Y.encodeStateAsUpdate(live);
    } else Y.applyUpdate(live, baseline);
    Y.applyUpdate(draft, branch.state);
    await db
      .update(documentBranches)
      .set({ hasEffect: !documentEffectsEqual(live, draft), liveCut: Buffer.from(baseline) })
      .where(eq(documentBranches.id, branchId));
  } finally {
    live.destroy();
    draft.destroy();
  }
}
